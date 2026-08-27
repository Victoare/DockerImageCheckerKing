// ---------------------------------------------------------------------------
// Container updates: the Clone and Swap flow, its live log stream, and the
// cache refresh that follows a successful swap.
// ---------------------------------------------------------------------------
const { resultStore, appendActivityLog, saveUpdateLog } = require('./store');
const { dockerApi } = require('./docker');
const { parseImageReference, pickVersionLabel } = require('./registry');
const { clearTelegramSentForContainer } = require('./telegram');
const { recordUpdate } = require('./metrics');

// ---------------------------------------------------------------------------
// In-memory state for active updates
// { [containerName]: { image, status: 'running'|'done'|'failed', log: [{time,msg,type}], clients: [res] } }
// ---------------------------------------------------------------------------
const activeUpdates = {};

// ---------------------------------------------------------------------------
// Retry queue
//
// The first attempt is deliberately unthrottled: hitting "update" on four rows
// fires four parallel swaps, which is fast when the registry and the daemon can
// take it. When one of them fails — usually a timeout while several pulls
// compete for the same layers — it is not failed outright but parked here, and
// the queue drains strictly one at a time. Only a container that fails its
// queued attempt as well ends up 'failed'.
// ---------------------------------------------------------------------------
const retryQueue = [];       // [{ container, image }]
let queueDraining = false;

// How many times the image pull itself is retried inside a single attempt.
const PULL_ATTEMPTS = parseInt(process.env.PULL_ATTEMPTS, 10) || 3;
const PULL_BACKOFF_MS = [5000, 15000, 45000];

// Seconds the daemon gives a container to exit on SIGTERM before killing it.
// This is a ceiling, not a wait: a container that exits immediately does not
// cost any of it. Docker's own default is 10s, which is short for anything that
// flushes state on shutdown (databases above all), so we are more patient.
const STOP_GRACE_SECONDS = parseInt(process.env.STOP_GRACE_SECONDS, 10) || 30;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function queuePosition(container) {
  const i = retryQueue.findIndex(j => j.container === container);
  return i === -1 ? null : i + 1;
}

function enqueueRetry(containerName, image) {
  const state = activeUpdates[containerName];
  if (retryQueue.some(j => j.container === containerName)) return;
  retryQueue.push({ container: containerName, image });
  if (state) state.status = 'queued';
  broadcastLog(containerName, {
    time: new Date().toISOString(),
    msg: `First attempt failed. Queued for a single retry (position ${queuePosition(containerName)}); the queue runs one update at a time.`,
    type: 'warn'
  });
  // Sent without closing the stream: the browser keeps the same EventSource and
  // just switches the row bar to its queued (purple) look.
  broadcastStatus(containerName, 'queued', { keepOpen: true, queuePosition: queuePosition(containerName) });
  appendActivityLog({ type: 'update-queued', container: containerName, image });
  drainQueue();
}

async function drainQueue() {
  if (queueDraining) return;
  queueDraining = true;
  try {
    while (retryQueue.length) {
      // Shifted before it runs, so the positions reported to everyone still
      // waiting count only the ones actually still waiting.
      const job = retryQueue.shift();
      const state = activeUpdates[job.container];
      if (!state) continue;
      state.status = 'running';
      broadcastStatus(job.container, 'running', { keepOpen: true });
      broadcastLog(job.container, { time: new Date().toISOString(), msg: '— Retry attempt (queued) —', type: 'info' });
      try {
        await runUpdate(job.container, job.image, 2);
      } catch (e) {
        console.warn('[update] Queued retry crashed for', job.container, e.message);
        finishUpdate(job.container, 'failed');
      }
      // Renumber whoever is still waiting so their row keeps an honest position.
      for (const j of retryQueue) {
        broadcastStatus(j.container, 'queued', { keepOpen: true, queuePosition: queuePosition(j.container) });
      }
    }
  } finally {
    queueDraining = false;
  }
}

function broadcastLog(container, line) {
  const state = activeUpdates[container];
  if (!state) return;
  // Lines carrying an id update the existing entry in place (live progress),
  // so the persisted log stays compact instead of growing one entry per tick.
  if (line.id) {
    const existing = state.log.find(l => l.id === line.id);
    if (existing) { existing.msg = line.msg; existing.type = line.type; existing.time = line.time; existing.bar = line.bar; }
    else state.log.push(line);
  } else {
    state.log.push(line);
  }
  const payload = `event: log\ndata: ${JSON.stringify(line)}\n\n`;
  for (const client of state.clients) try { client.write(payload); } catch { /* disconnected */ }
}

// Terminal statuses close the stream; intermediate ones ('queued', a queued
// attempt going back to 'running') keep it open so the browser follows the
// whole journey on one connection.
function broadcastStatus(container, status, { keepOpen = false, queuePosition = null } = {}) {
  const state = activeUpdates[container];
  if (!state) return;
  const payload = `event: status\ndata: ${JSON.stringify({ status, queuePosition })}\n\n`;
  for (const client of state.clients) {
    try { client.write(payload); if (!keepOpen) client.end(); } catch { /* skip */ }
  }
  if (!keepOpen) state.clients = [];
}

// ---------------------------------------------------------------------------
// CORE: "Clone & Swap" Update Logic (Watchtower style)
// ---------------------------------------------------------------------------
// Attempt 1 is the free-for-all one; a failure there parks the container in the
// retry queue instead of failing it. Attempt 2 runs alone from that queue, and
// its failure is final.
async function runUpdate(containerName, image, attempt = 1) {
  const succeeded = await performUpdate(containerName, image);
  if (succeeded) return finishUpdate(containerName, 'done');
  if (attempt === 1) return enqueueRetry(containerName, image);
  return finishUpdate(containerName, 'failed');
}

// Runs one full Clone & Swap. Returns true on success; on failure it has
// already restored the previous container (as far as it could) and logged why.
async function performUpdate(containerName, image) {
  const log = (msg, type = 'info', id, bar) => broadcastLog(containerName, { time: new Date().toISOString(), msg, type, ...(id ? { id } : {}), ...(bar ? { bar } : {}) });

  // Everything the rollback needs. `renamed` is the point of no return: past it
  // the original container no longer answers to its own name, so any failure
  // has to put it back rather than just bailing out.
  let oldInfo = null, oldName = null, newId = null, renamed = false, wasRunning = false;

  // Puts the original container back under its own name and restarts it if it
  // had been running. Best effort — every step is reported, never thrown.
  const rollback = async (reason) => {
    if (!renamed || !oldInfo) return;
    log(`Rollback (${reason}): restoring "${containerName}" …`, 'warn');
    try {
      if (newId) {
        await dockerApi('POST', `/containers/${newId}/stop?t=5`, { timeout: 20000 });
        await dockerApi('DELETE', `/containers/${newId}?v=false`);
        log('Removed the half-created new container.', 'warn');
      }
    } catch (e) { log(`Could not remove the new container: ${e.message}`, 'error'); }
    try {
      await dockerApi('POST', `/containers/${oldInfo.Id}/rename?name=${encodeURIComponent(containerName)}`);
      renamed = false;
      if (wasRunning) {
        await dockerApi('POST', `/containers/${oldInfo.Id}/start`, { timeout: 60000 });
        log('Previous container restored and started.', 'warn');
      } else {
        log('Previous container restored (left stopped, as it was).', 'warn');
      }
    } catch (e) {
      log(`ROLLBACK FAILED: the previous container is still named "${oldName}" (${e.message}). Manual action required.`, 'error');
    }
  };

  try {
    // 1. PULL IMAGE
    const parsed = parseImageReference(image);
    if (!parsed) {
      log(`Image pinned by digest (${image}), skipped pull.`, 'warn');
    } else {
      let fromImage = (parsed.registry === 'docker.io') ? (parsed.repo.startsWith('library/') ? parsed.repo.substring(8) : parsed.repo) : `${parsed.registry}/${parsed.repo}`;
      log(`Pulling ${fromImage}:${parsed.tag} …`, 'info');
      let pullOk = false;
      // A pull is idempotent, so a transient failure (timeout, reset socket,
      // registry hiccup) is worth simply retrying before the whole update is
      // written off. The swap steps below get no such treatment.
      for (let pullAttempt = 1; pullAttempt <= PULL_ATTEMPTS && !pullOk; pullAttempt++) {
        if (pullAttempt > 1) {
          const wait = PULL_BACKOFF_MS[Math.min(pullAttempt - 2, PULL_BACKOFF_MS.length - 1)];
          log(`Retrying pull in ${Math.round(wait / 1000)}s (attempt ${pullAttempt}/${PULL_ATTEMPTS}) …`, 'warn');
          await sleep(wait);
        }
        let failed = false;
        // The Docker pull stream emits one event per layer status change (often
        // hundreds per second). Instead of one log line each, we keep per-layer
        // state and render in-place updating progress bars: one aggregate bar
        // ('pull-overall') plus one bar per layer ('pull-layer-<id>'). Each layer
        // tracks its download and extract byte progress separately.
        const fmtBytes = (n) => {
          if (n == null) return '';
          const u = ['B', 'KB', 'MB', 'GB', 'TB'];
          let i = 0, v = n;
          while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
          return (i === 0 ? v : (v >= 10 ? Math.round(v) : v.toFixed(1))) + u[i];
        };
        const shortId = (id) => id.length > 12 ? id.slice(0, 12) : id;
        const layers = {};        // id -> { phase, dlCur, dlTot, exCur, exTot, terminal }
        const seenMessages = new Set();
        const lastEmit = {};      // log id -> last emitted pct (throttle)

        const layerPct = (L) => {
          if (L.phase === 'done' || L.phase === 'downloaded') return 100;
          if (L.phase === 'extracting') return L.exTot ? Math.round(L.exCur / L.exTot * 100) : 0;
          if (L.phase === 'downloading') return L.dlTot ? Math.round(L.dlCur / L.dlTot * 100) : 0;
          return 0;
        };
        const layerLabel = (L) => ({
          pending: 'Waiting', downloading: 'Downloading',
          downloaded: 'Download complete', extracting: 'Extracting',
          done: L.terminal || 'Pull complete'
        })[L.phase] || '';
        const layerRight = (L) => {
          if (L.phase === 'downloading' && L.dlTot) return `${fmtBytes(L.dlCur)} / ${fmtBytes(L.dlTot)}`;
          if (L.phase === 'extracting' && L.exTot) return `${Math.round(L.exCur / L.exTot * 100)}%`;
          return '';
        };
        const emitLayer = (id) => {
          const L = layers[id], key = 'pull-layer-' + id, pct = layerPct(L);
          const sig = L.phase + ':' + pct;
          if (lastEmit[key] === sig) return;
          lastEmit[key] = sig;
          log('', L.phase === 'done' ? 'ok' : 'info', key, { pct, left: `${shortId(id)}  ${layerLabel(L)}`, right: layerRight(L) });
        };
        const emitOverall = (force) => {
          const ids = Object.keys(layers);
          if (!ids.length) return;
          let frac = 0, done = 0, sumCur = 0, sumTot = 0;
          for (const id of ids) {
            const L = layers[id];
            if (L.phase === 'done') { frac += 1; done++; }
            else if (L.phase === 'extracting') frac += 0.5 + 0.5 * (L.exTot ? L.exCur / L.exTot : 0);
            else if (L.phase === 'downloaded') frac += 0.5;
            else if (L.phase === 'downloading') frac += 0.5 * (L.dlTot ? L.dlCur / L.dlTot : 0);
            if (L.dlTot) { sumCur += L.dlCur; sumTot += L.dlTot; }
          }
          const pct = Math.round(frac / ids.length * 100);
          // Throttle on pct AND done: fractional credit can push pct to 100 while
          // layers are still extracting, so keying on pct alone would freeze the
          // "X / Y complete" label once that happens.
          const sig = pct + ':' + done;
          if (!force && lastEmit['pull-overall'] === sig) return;
          lastEmit['pull-overall'] = sig;
          const right = sumTot ? `${fmtBytes(sumCur)} / ${fmtBytes(sumTot)}` : '';
          log('', done === ids.length ? 'ok' : 'info', 'pull-overall', { pct, left: `Layers  ${done} / ${ids.length} complete`, right });
        };

        let pullCode = 0;
        try {
          pullCode = await dockerApi('POST', `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(parsed.tag)}`, {
            stream: (chunk) => {
              if (chunk.error) { log(`Pull error: ${chunk.error}`, 'error'); failed = true; return; }
              // A non-200 from the daemon (unknown tag, auth failure, registry
              // down) arrives as a bare {message}. Without this the log showed
              // the retries but never said what went wrong.
              if (chunk.message && !chunk.status) { log(`Pull error: ${chunk.message}`, 'warn'); failed = true; return; }
              if (!chunk.status) return;
              if (!chunk.id) {
                // Non-layer status (e.g. "Pulling from repo", "Digest: …", "Status: …"); log once.
                if (!seenMessages.has(chunk.status)) { seenMessages.add(chunk.status); log(chunk.status, 'info'); }
                return;
              }
              const id = chunk.id;
              const pd = chunk.progressDetail || {};
              // Build on a copy and only commit to `layers` once we've handled the
              // status — otherwise an unmapped status on a fresh id would register a
              // phantom 'pending' layer that inflates the total but never completes.
              const L = layers[id] || { phase: 'pending', dlCur: 0, dlTot: 0, exCur: 0, exTot: 0 };
              switch (chunk.status) {
                case 'Pulling fs layer': case 'Waiting': L.phase = 'pending'; break;
                case 'Downloading': L.phase = 'downloading'; if (pd.current != null) L.dlCur = pd.current; if (pd.total) L.dlTot = pd.total; break;
                case 'Verifying Checksum': L.phase = 'downloading'; break;
                case 'Download complete': L.phase = 'downloaded'; if (L.dlTot) L.dlCur = L.dlTot; break;
                case 'Extracting': L.phase = 'extracting'; if (pd.current != null) L.exCur = pd.current; if (pd.total) L.exTot = pd.total; break;
                case 'Pull complete': L.phase = 'done'; L.terminal = 'Pull complete'; break;
                case 'Already exists': L.phase = 'done'; L.terminal = 'Already exists'; break;
                default: return; // unknown status — ignore, don't register a phantom layer
              }
              layers[id] = L;
              emitOverall();   // emitted first so the aggregate bar stays on top
              emitLayer(id);
            }
          });
        } catch (e) {
          log(`Pull error: ${e.message}`, 'warn');
          failed = true;
        }
        if (!failed && pullCode === 200) {
          pullOk = true;
          emitOverall(true);   // force a final flush so the aggregate bar always lands on 100%
        } else if (pullAttempt >= PULL_ATTEMPTS) {
          log(`Pull failed after ${PULL_ATTEMPTS} attempt(s).`, 'error');
        }
      }
      if (!pullOk) return false;
      log('Pull complete.', 'ok');
    }

    // 2. INSPECT OLD CONTAINER
    log(`Inspecting "${containerName}" …`, 'info');
    oldInfo = await dockerApi('GET', `/containers/${encodeURIComponent(containerName)}/json`);
    if (!oldInfo || !oldInfo.Id) { log('Failed to inspect container.', 'error'); return false; }
    wasRunning = !!(oldInfo.State && oldInfo.State.Running);

    // 3. STOP OLD (only if running)
    if (wasRunning) {
      log(`Stopping "${containerName}" …`, 'info');
      // The daemon waits t seconds for SIGTERM before it kills, so the HTTP
      // call itself can legitimately outlive the default timeout — give it the
      // grace period plus room to answer.
      const stopRes = await dockerApi('POST', `/containers/${oldInfo.Id}/stop?t=${STOP_GRACE_SECONDS}`, { timeout: (STOP_GRACE_SECONDS + 30) * 1000 });
      // 304 = already stopped, which is fine. Anything else means the container
      // may still be running, and renaming it now would be the worst outcome.
      if (stopRes.statusCode !== 204 && stopRes.statusCode !== 304) {
        log(`Stop failed (HTTP ${stopRes.statusCode}): ${JSON.stringify(stopRes.body)}`, 'error');
        return false;
      }
    } else {
      log(`Container "${containerName}" was not running, skipping stop.`, 'info');
    }

    // 4. RENAME OLD
    oldName = containerName + '_old_' + Date.now();
    log(`Renaming old container to "${oldName}" …`, 'info');
    const renameRes = await dockerApi('POST', `/containers/${oldInfo.Id}/rename?name=${encodeURIComponent(oldName)}`);
    if (renameRes.statusCode < 200 || renameRes.statusCode >= 300) {
      log(`Rename failed (HTTP ${renameRes.statusCode}): ${JSON.stringify(renameRes.body)}`, 'error');
      if (wasRunning) { try { await dockerApi('POST', `/containers/${oldInfo.Id}/start`, { timeout: 60000 }); } catch { /* reported below */ } }
      return false;
    }
    renamed = true;

    // 5. CREATE NEW (CLONE CONFIG)
    log(`Creating new container "${containerName}" …`, 'info');

    const config = { ...oldInfo.Config };
    config.Image = image;

    // Docker bakes the image's labels into the container config at create time,
    // so a plain clone would freeze the OLD image's labels (e.g. a stale
    // org.opencontainers.image.version) onto the new container. Drop every label
    // whose value is identical to the old image's — those are purely inherited,
    // and the new image will supply its own. Labels the user set explicitly
    // (compose labels, reverse-proxy rules, or an intentional override with a
    // different value) are kept untouched.
    if (config.Labels && oldInfo.Image) {
      try {
        const oldImg = await dockerApi('GET', `/images/${encodeURIComponent(oldInfo.Image)}/json`);
        const imgLabels = (oldImg.Config && oldImg.Config.Labels) || null;
        if (imgLabels) {
          const labels = { ...config.Labels };
          let dropped = 0;
          // Build-metadata namespaces are always image-provided provenance; a
          // container-level override of them is never intentional, and a value
          // mismatch there just means the label got frozen by an *earlier* swap.
          const isProvenance = (k) => k.startsWith('org.opencontainers.image.')
            || k.startsWith('org.label-schema.');
          for (const k of Object.keys(imgLabels)) {
            if (labels[k] === imgLabels[k] || isProvenance(k)) { delete labels[k]; dropped++; }
          }
          for (const k of Object.keys(labels)) {
            if (isProvenance(k)) { delete labels[k]; dropped++; }
          }
          if (dropped) log(`Dropped ${dropped} label(s) inherited from the old image, the new image provides its own.`, 'info');
          config.Labels = labels;
        }
      } catch (e) { log(`Could not read old image labels (${e.message}), cloning them as-is.`, 'warn'); }
    }

    const createBody = {
      ...config,
      HostConfig: oldInfo.HostConfig,
      NetworkingConfig: {
        EndpointsConfig: oldInfo.NetworkSettings.Networks
      }
    };

    // Remove runtime-only or conflicting fields
    delete createBody.Hostname;

    const createRes = await dockerApi('POST', `/containers/create?name=${encodeURIComponent(containerName)}`, { body: createBody, timeout: 60000 });
    if (createRes.statusCode !== 201) {
      log(`Create failed (HTTP ${createRes.statusCode}): ${JSON.stringify(createRes.body)}`, 'error');
      await rollback('create failed');
      return false;
    }
    newId = createRes.body.Id;

    // 6. START NEW (only if it was running before)
    if (wasRunning) {
      log(`Starting new container …`, 'info');
      const startRes = await dockerApi('POST', `/containers/${newId}/start`, { timeout: 60000 });
      if (startRes.statusCode < 200 || startRes.statusCode >= 300) {
        log(`Start failed: ${JSON.stringify(startRes.body)}`, 'error');
        await rollback('start failed');
        return false;
      }
    } else {
      log(`Container was not running before update, leaving it stopped.`, 'info');
    }

    // 7. CLEANUP OLD
    log(`Deleting old container …`, 'info');
    // From here the swap has succeeded; a failure to delete the leftover is
    // untidy but must not roll a working container back.
    renamed = false;
    try {
      await dockerApi('DELETE', `/containers/${oldInfo.Id}?v=true`);
    } catch (e) {
      log(`Could not delete the old container "${oldName}" (${e.message}) — remove it manually.`, 'warn');
    }

    log(`Update successful!`, 'ok');
    return true;

  } catch (err) {
    log(`Error: ${err.message}`, 'error');
    await rollback(err.message);
    return false;
  }
}

async function finishUpdate(containerName, status) {
  const state = activeUpdates[containerName];
  if (!state) return;
  state.status = status;
  const finishedAt = new Date().toISOString();
  const entry = { image: state.image, startedAt: state.startedAt, finishedAt, status, log: state.log };
  // A failed update stays visible on the row until it is superseded. Recording
  // what the container looked like at the moment of failure is what lets a
  // later check tell "still broken" from "someone updated it another way":
  // either a new image digest or a different container id means the row moved
  // on, and the stale red marker is dropped.
  if (status === 'failed') entry.failedState = await captureContainerFingerprint(containerName);
  saveUpdateLog(containerName, entry);
  appendActivityLog({ type: 'update-install', container: containerName, image: state.image, status, startedAt: state.startedAt, finishedAt });
  recordUpdate(status);
  // Refresh the cache BEFORE broadcasting: on 'done' the UI immediately reads
  // /api/last-result back, so the fresh digest/version must already be in there
  // — otherwise it would render the pre-update values.
  if (status === 'done') {
    await refreshCacheAfterUpdate(containerName, state.image);
    clearTelegramSentForContainer(containerName);
  }
  broadcastStatus(containerName, status);
  setTimeout(() => delete activeUpdates[containerName], 30000);
}

// Digest + container id as they are right now; both are cheap and either one
// changing is enough to consider a past failure superseded.
async function captureContainerFingerprint(containerName) {
  const fp = { localDigest: null, containerId: null };
  try {
    const ctr = await dockerApi('GET', `/containers/${encodeURIComponent(containerName)}/json`);
    if (ctr && ctr.Id) fp.containerId = ctr.Id;
    if (ctr && ctr.Image) {
      const img = await dockerApi('GET', `/images/${encodeURIComponent(ctr.Image)}/json`);
      for (const d of (img.RepoDigests || [])) {
        const m = d.match(/@(sha256:[a-f0-9]+)/);
        if (m) { fp.localDigest = m[1]; break; }
      }
    }
  } catch (e) { console.warn('[update] Could not fingerprint', containerName, e.message); }
  return fp;
}

async function refreshCacheAfterUpdate(containerName, image) {
  try {
    const cache = resultStore.load();
    if (!cache || !cache.results) return;
    const row = cache.results.find(r => r.container === containerName);
    if (!row) return;
    // Re-inspect the pulled image to get fresh local digest + OCI version label
    let localDigest = null, localVersion = null;
    try {
      const inspect = await dockerApi('GET', `/images/${encodeURIComponent(image)}/json`);
      if (inspect.RepoDigests && inspect.RepoDigests.length > 0) {
        for (const d of inspect.RepoDigests) {
          const m = d.match(/@(sha256:[a-f0-9]+)/);
          if (m) { localDigest = m[1]; break; }
        }
      }
      localVersion = pickVersionLabel((inspect.Config && inspect.Config.Labels) || null);
    } catch (e) { console.warn('[cache] Could not inspect image after update:', e.message); }
    if (localDigest) {
      row.localDigest = localDigest;
      row.remoteDigest = localDigest;
    }
    // The container now runs exactly this image, so the "Detected" column must
    // show its label — otherwise the pre-update value lingers until the next check.
    row.localVersion = localVersion || '-';
    if (localDigest) row.remoteVersion = row.localVersion;
    row.result = 'UpToDate';
    // Refresh state/status too: the row otherwise keeps the old container's uptime.
    try {
      const ctr = await dockerApi('GET', `/containers/${encodeURIComponent(containerName)}/json`);
      if (ctr && ctr.State) {
        row.state = ctr.State.Status || row.state;
        row.status = ctr.State.Running
          ? 'Up (just updated)'
          : (ctr.State.Status ? ctr.State.Status.charAt(0).toUpperCase() + ctr.State.Status.slice(1) : row.status);
      }
    } catch (e) { console.warn('[cache] Could not inspect container after update:', e.message); }
    cache.timestamp = new Date().toISOString();
    resultStore.save(cache);
  } catch (e) { console.warn('[cache] Failed to refresh after update:', e.message); }
}

module.exports = { activeUpdates, runUpdate, broadcastLog, broadcastStatus, queuePosition, retryQueue };
