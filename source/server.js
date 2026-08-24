const express = require('express');
const path = require('path');

const { resultStore, rateLimitStore, appendActivityLog, loadUpdateLogs } = require('./store');
const { dockerApi } = require('./docker');
const { parseImageReference, pickVersionLabel, fetchRemoteInfo, httpsGet } = require('./registry');
const {
  TELEGRAM_BOT_TOKEN, DEFAULT_TELEGRAM_TEMPLATE,
  loadTelegramConfig, saveTelegramConfig,
  loadTelegramTemplate, saveTelegramTemplate, renderTelegramTemplate,
  sendTelegramMessage, sendTelegramNotifications,
  loadContainerNotify, saveContainerNotify, getNotifyInfo
} = require('./telegram');
const { activeUpdates, runUpdate } = require('./updater');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// ---------------------------------------------------------------------------
// Shared check logic (used by both SSE endpoint and auto-check)
// ---------------------------------------------------------------------------
async function runCheck(includeStopped, { onTotal, onProgress, onResult } = {}) {
  // Load previous results: the digests drive update-event logging, and the
  // digest+version pairs let fetchRemoteInfo() skip the version walk for
  // images that have not moved since the last run.
  let prevDigests = {};
  const knownByImage = {};
  try {
    const prev = resultStore.load();
    if (prev && prev.results) {
      for (const r of prev.results) {
        prevDigests[r.container] = r.remoteDigest;
        const p = parseImageReference(r.image);
        if (p && r.remoteDigest && r.remoteDigest !== '-') {
          knownByImage[p.cacheKey] = {
            digest: r.remoteDigest,
            version: r.remoteVersion && r.remoteVersion !== '-' ? r.remoteVersion : null
          };
        }
      }
    }
  } catch { /* no previous cache */ }

  const containerList = await dockerApi('GET', `/containers/json?all=${includeStopped}`);
  if (onTotal) onTotal({ count: containerList.length });
  const infoCache = {};
  const results = [];
  for (let i = 0; i < containerList.length; i++) {
    const ctr = containerList[i];
    const name = (ctr.Names && ctr.Names[0]) ? ctr.Names[0].replace(/^\//, '') : ctr.Id.substring(0, 12);
    const image = ctr.Image;
    if (onProgress) onProgress({ index: i, total: containerList.length, container: name, image });
    const parsed = parseImageReference(image);
    if (!parsed) {
      const row = { container: name, image, state: ctr.State, status: ctr.Status, registry: '-', tag: '-', result: 'Pinned', localDigest: '-', remoteDigest: '-', ...getNotifyInfo(name, ctr.State) };
      results.push(row); if (onResult) onResult(row); continue;
    }
    let localDigest = null;
    let localVersion = null;
    const extractFromInspect = (inspect) => {
      if (inspect.RepoDigests && inspect.RepoDigests.length > 0) {
        for (const d of inspect.RepoDigests) {
          const m = d.match(/@(sha256:[a-f0-9]+)/);
          if (m) { localDigest = m[1]; break; }
        }
      }
      localVersion = pickVersionLabel((inspect.Config && inspect.Config.Labels) || null);
    };
    try {
      extractFromInspect(await dockerApi('GET', `/images/${encodeURIComponent(image)}/json`));
    } catch (e) {
      try {
        extractFromInspect(await dockerApi('GET', `/images/${ctr.ImageID}/json`));
      } catch (e2) { console.warn(`[check] Could not inspect image for ${name}:`, e2.message); }
    }
    let info, fromCache = false;
    if (infoCache.hasOwnProperty(parsed.cacheKey)) {
      info = infoCache[parsed.cacheKey]; fromCache = true;
    } else {
      const known = knownByImage[parsed.cacheKey] || {};
      info = await fetchRemoteInfo(parsed.registry, parsed.repo, parsed.tag, known);
      // Some registries only mirror; fall back to Docker Hub for the same repo.
      if (info.digest === null && parsed.registry !== 'docker.io') {
        info = await fetchRemoteInfo('docker.io', parsed.repo, parsed.tag, known);
      }
      infoCache[parsed.cacheKey] = info;
    }
    const remoteDigest = info.digest;
    const remoteVersion = info.version;
    let result = 'Unknown';
    if (remoteDigest === null) result = 'Unknown';
    else if (localDigest === null) result = 'NoLocalDigest';
    else if (localDigest === remoteDigest) result = 'UpToDate';
    else result = 'Outdated';
    const row = { container: name, image, state: ctr.State, status: ctr.Status, registry: parsed.registry, tag: parsed.tag, result, localDigest: localDigest || '-', remoteDigest: remoteDigest || '-', localVersion: localVersion || '-', remoteVersion: remoteVersion || '-', cached: fromCache, ...getNotifyInfo(name, ctr.State) };
    results.push(row); if (onResult) onResult(row);
  }
  const timestamp = new Date().toISOString();
  resultStore.save({ timestamp, results });
  const outdatedResults = results.filter(r => r.result === 'Outdated');
  appendActivityLog({ type: 'check', checked: results.length, outdated: outdatedResults.length });
  for (const r of outdatedResults) {
    if (prevDigests[r.container] !== r.remoteDigest) {
      appendActivityLog({ type: 'update-event', container: r.container, image: r.image, state: r.state, localDigest: r.localDigest, remoteDigest: r.remoteDigest });
    }
  }
  return { timestamp, results };
}

// ---------------------------------------------------------------------------
// Only one check may be in flight at a time.
//
// A manual check started while the auto-check is running would race it on
// last-result.json (one run's results silently lost), and both runs would send
// their own Telegram notifications for the same outdated containers. A second
// caller therefore attaches to the running check instead of starting its own:
// it gets the rows produced so far replayed, then follows along live.
// ---------------------------------------------------------------------------
let checkInFlight = null;

function runCheckExclusive(includeStopped, handlers = {}) {
  if (checkInFlight) {
    const run = checkInFlight;
    if (handlers.onTotal && run.total !== null) handlers.onTotal({ count: run.total });
    if (handlers.onResult) for (const row of run.produced) handlers.onResult(row);
    run.subscribers.add(handlers);
    return run.promise.finally(() => run.subscribers.delete(handlers));
  }

  const run = { total: null, produced: [], subscribers: new Set([handlers]) };
  const fanout = (name, arg) => {
    for (const sub of run.subscribers) {
      try { if (sub[name]) sub[name](arg); } catch (e) { console.warn('[check] Subscriber failed:', e.message); }
    }
  };

  run.promise = (async () => {
    try {
      const result = await runCheck(includeStopped, {
        onTotal: (t) => { run.total = t.count; fanout('onTotal', t); },
        onProgress: (p) => fanout('onProgress', p),
        onResult: (r) => { run.produced.push(r); fanout('onResult', r); }
      });
      // Notifications belong to the run, not to whoever asked for it — sending
      // them per caller would deliver one message per attached client.
      sendTelegramNotifications(result.results).catch(e => console.warn('[telegram] Notification error:', e.message));
      return result;
    } finally {
      checkInFlight = null;
    }
  })();

  checkInFlight = run;
  return run.promise;
}

app.get('/api/check', async (req, res) => {
  const includeStopped = req.query.includeStopped === 'true';
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    const result = await runCheckExclusive(includeStopped, {
      onTotal: (t) => send('total', t),
      onProgress: (p) => send('progress', p),
      onResult: (r) => send('result', r)
    });
    scheduleNextAutoCheck();
    send('done', { total: result.results.length });
  } catch (err) { send('error', { message: err.message }); }
  res.end();
});

// Telegram API endpoints
app.get('/api/telegram/config', (_req, res) => {
  // hasToken is derived, not stored — copy so it does not end up in the file.
  res.json({ ...loadTelegramConfig(), hasToken: !!TELEGRAM_BOT_TOKEN });
});

app.post('/api/telegram/config', (req, res) => {
  const config = req.body;
  if (!config || !Array.isArray(config.chats)) return res.status(400).json({ error: 'Invalid config' });
  // The client echoes back the derived token flags; they are not config.
  delete config.hasToken;
  delete config._hasToken;
  saveTelegramConfig(config);
  res.json({ ok: true });
});

app.post('/api/telegram/test', async (req, res) => {
  const { chatId } = req.body;
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  if (!TELEGRAM_BOT_TOKEN) return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not configured' });
  try {
    const template = loadTelegramTemplate();
    const mockRow = { container: 'my-awesome-app', image: 'nginx:latest', registry: 'docker.io', tag: 'latest', state: 'running', status: 'Up 3 days', localDigest: 'sha256:abc123...', remoteDigest: 'sha256:def456...' };
    const text = renderTelegramTemplate(template, mockRow);
    const result = await sendTelegramMessage(chatId, text);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/telegram/template', (_req, res) => {
  res.json({ template: loadTelegramTemplate(), default: DEFAULT_TELEGRAM_TEMPLATE });
});

app.post('/api/telegram/template', (req, res) => {
  const { template } = req.body;
  if (typeof template !== 'string') return res.status(400).json({ error: 'template string required' });
  saveTelegramTemplate(template);
  res.json({ ok: true });
});

app.post('/api/telegram/template/send', async (req, res) => {
  const { chatId, template, container } = req.body;
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  if (!template) return res.status(400).json({ error: 'template required' });
  if (!TELEGRAM_BOT_TOKEN) return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not configured' });
  let row;
  if (container) {
    try {
      const cache = resultStore.load();
      row = cache && cache.results && cache.results.find(r => r.container === container);
    } catch {}
  }
  if (!row) {
    row = { container: 'my-awesome-app', image: 'nginx:latest', registry: 'docker.io', tag: 'latest', state: 'running', status: 'Up 3 days', localDigest: 'sha256:abc123...', remoteDigest: 'sha256:def456...' };
  }
  try {
    const text = renderTelegramTemplate(template, row);
    const result = await sendTelegramMessage(chatId, text);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/telegram/discover', async (_req, res) => {
  if (!TELEGRAM_BOT_TOKEN) return res.status(400).json({ error: 'TELEGRAM_BOT_TOKEN not configured' });
  try {
    const updatesRes = await httpsGet(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?limit=100`);
    if (updatesRes.statusCode !== 200) return res.status(500).json({ error: 'Telegram API error' });
    const data = JSON.parse(updatesRes.body);
    if (!data.ok) return res.status(500).json({ error: data.description || 'Unknown error' });

    const seen = {};
    for (const update of (data.result || [])) {
      const msg = update.message || update.my_chat_member && update.my_chat_member.chat;
      const chat = msg && (msg.chat || msg);
      if (!chat || !chat.id) continue;
      if (seen[chat.id]) continue;
      seen[chat.id] = {
        chatId: String(chat.id),
        name: chat.title || chat.first_name || chat.username || '',
        type: chat.type || 'unknown'
      };
    }
    res.json(Object.values(seen));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/container-notify', (_req, res) => {
  res.json(loadContainerNotify());
});

app.get('/api/container-notify/:container', (req, res) => {
  const all = loadContainerNotify();
  res.json(all[req.params.container] || null);
});

app.post('/api/container-notify/:container', (req, res) => {
  const all = loadContainerNotify();
  all[req.params.container] = req.body;
  saveContainerNotify(all);
  res.json({ ok: true });
});

app.delete('/api/container-notify/:container', (req, res) => {
  const all = loadContainerNotify();
  delete all[req.params.container];
  saveContainerNotify(all);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Global SSE event bus (for pushing auto-check results to all connected clients)
// ---------------------------------------------------------------------------
const eventClients = [];

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(':ok\n\n');
  eventClients.push(res);
  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { /* disconnected */ }
  }, 25000);
  req.on('close', () => {
    clearInterval(keepalive);
    const idx = eventClients.indexOf(res);
    if (idx !== -1) eventClients.splice(idx, 1);
  });
});

function broadcastEvent(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of eventClients) {
    try { client.write(payload); } catch { /* disconnected */ }
  }
}

// ---------------------------------------------------------------------------
// Auto-check scheduler
// ---------------------------------------------------------------------------
const AUTO_CHECK_FAST_MINUTES = parseInt(process.env.AUTO_CHECK_FAST_MINUTES, 10) || 60;
const AUTO_CHECK_SLOW_MINUTES = parseInt(process.env.AUTO_CHECK_MINUTES, 10) || 360;
const AUTO_CHECK_FAST = AUTO_CHECK_FAST_MINUTES * 60 * 1000;
const AUTO_CHECK_SLOW = AUTO_CHECK_SLOW_MINUTES * 60 * 1000;
let nextAutoCheckTime = null;
let autoCheckTimer = null;

function getAutoCheckInterval() {
  const dh = rateLimitStore.load()['docker.io'];
  if (dh && dh.limit && dh.remaining !== null) {
    const pct = dh.remaining / dh.limit;
    if (pct >= 0.8) {
      console.log(`[auto-check] Rate limit healthy (${dh.remaining}/${dh.limit}), using fast interval (${AUTO_CHECK_FAST_MINUTES}m)`);
      return AUTO_CHECK_FAST;
    }
    console.log(`[auto-check] Rate limit low (${dh.remaining}/${dh.limit}), using slow interval (${AUTO_CHECK_SLOW_MINUTES}m)`);
    return AUTO_CHECK_SLOW;
  }
  return AUTO_CHECK_FAST;
}

function scheduleNextAutoCheck() {
  if (autoCheckTimer) clearTimeout(autoCheckTimer);

  const interval = getAutoCheckInterval();

  let lastCheckTime = null;
  try {
    const cache = resultStore.load();
    if (cache && cache.timestamp) lastCheckTime = new Date(cache.timestamp).getTime();
  } catch { /* no cache yet */ }

  const now = Date.now();
  let delay;
  if (lastCheckTime && (lastCheckTime + interval) > now) {
    delay = (lastCheckTime + interval) - now;
  } else {
    delay = 30000;
  }

  nextAutoCheckTime = new Date(now + delay).toISOString();
  console.log(`Next auto-check scheduled at ${nextAutoCheckTime}`);

  autoCheckTimer = setTimeout(async () => {
    console.log('Running auto-check…');
    broadcastEvent('auto-check-start', {});
    try {
      const autoResult = await runCheckExclusive(true);
      console.log('Auto-check complete.');
      broadcastEvent('auto-check-done', { timestamp: autoResult.timestamp, count: autoResult.results.length });
    } catch (e) {
      console.error('Auto-check failed:', e.message);
      broadcastEvent('auto-check-done', { error: e.message });
    }
    scheduleNextAutoCheck();
  }, delay);
}

app.get('/api/next-check', (_req, res) => {
  res.json({ nextAutoCheck: nextAutoCheckTime, intervalMs: getAutoCheckInterval(), fastMinutes: AUTO_CHECK_FAST_MINUTES, slowMinutes: AUTO_CHECK_SLOW_MINUTES });
});

app.get('/api/rate-limits', (_req, res) => {
  res.json(rateLimitStore.load());
});

app.get('/api/last-result', (_req, res) => {
  const cache = resultStore.load();
  if (!cache) return res.json(null);
  // Copy the rows: the store hands out its cached object, and mutating it here
  // would write the notify flags back to disk on the next save.
  const results = (cache.results || []).map(row => ({ ...row, ...getNotifyInfo(row.container, row.state) }));
  res.json({ ...cache, results });
});

app.get('/api/version', (_req, res) => res.json({ version: process.env.BUILD_VERSION || 'dev' }));

app.get('/api/update-logs', (_req, res) => res.json(loadUpdateLogs()));

app.get('/api/update-status', (_req, res) => {
  const status = {};
  for (const [name, state] of Object.entries(activeUpdates)) status[name] = { status: state.status, image: state.image };
  res.json(status);
});

app.post('/api/update/:container', async (req, res) => {
  const name = req.params.container;
  if (activeUpdates[name] && activeUpdates[name].status === 'running') return res.status(409).json({ error: 'Update in progress' });
  let image = req.body && req.body.image;
  if (!image) {
    try {
      const ctrs = await dockerApi('GET', '/containers/json?all=true');
      const ctr = ctrs.find(c => c.Names && c.Names.some(n => n.replace(/^\//, '') === name));
      if (!ctr) return res.status(404).json({ error: 'Container not found' });
      image = ctr.Image;
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  activeUpdates[name] = { image, status: 'running', startedAt: new Date().toISOString(), log: [], clients: [] };
  res.json({ ok: true, container: name, image });
  runUpdate(name, image);
});

app.get('/api/update/:container/stream', (req, res) => {
  const name = req.params.container, state = activeUpdates[name];
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (!state) { res.write(`event: status\ndata: ${JSON.stringify({ status: 'none' })}\n\n`); res.end(); return; }
  for (const line of state.log) res.write(`event: log\ndata: ${JSON.stringify(line)}\n\n`);
  if (state.status !== 'running') { res.write(`event: status\ndata: ${JSON.stringify({ status: state.status })}\n\n`); res.end(); return; }
  state.clients.push(res);
  req.on('close', () => { if (state.clients) { const idx = state.clients.indexOf(res); if (idx !== -1) state.clients.splice(idx, 1); } });
});

// The app ships as plain files with no build step, so a new image would
// otherwise keep serving whatever the browser cached. no-cache does not mean
// "don't cache" — it means "revalidate first", so unchanged files still come
// back as a cheap 304.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders(res, filePath) {
    if (/\.(html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  }
}));
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Docker Image Checker running on http://0.0.0.0:${PORT}`);
  scheduleNextAutoCheck();
});
