// =========================================================================
// Update feature
// =========================================================================

// Map container name -> idx (for finding the right detail row)
function getIdxByContainer(container) {
  var rows = document.querySelectorAll('#resultsBody tr.result-row');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].dataset.container === container) return rows[i].dataset.idx;
  }
  return null;
}

function addUpdateLog(idx, line) {
  var logEl = document.getElementById('update-log-' + idx);
  if (!logEl) return;
  var wrapEl = document.getElementById('update-log-wrap-' + idx);
  if (wrapEl) wrapEl.style.display = '';

  // Lines with an id update an existing row in place (e.g. live pull progress)
  // instead of appending a new one each tick.
  var div = line.id ? logEl.querySelector('[data-log-id="' + CSS.escape(line.id) + '"]') : null;
  var created = !div;
  if (!div) {
    div = document.createElement('div');
    if (line.id) div.setAttribute('data-log-id', line.id);
    logEl.appendChild(div);
  }

  if (line.bar) {
    div.className = 'update-log-bar' + (line.type ? ' ' + line.type : '');
    renderBar(div, line.bar);
  } else {
    var ts = line.time ? '[' + new Date(line.time).toLocaleTimeString() + '] ' : '';
    div.className = 'update-log-line' + (line.type ? ' ' + line.type : '');
    div.textContent = ts + line.msg;
  }

  // Only auto-scroll when a new row appears; in-place bar updates must not yank
  // the view to the bottom on every tick.
  if (created) logEl.scrollTop = logEl.scrollHeight;
}

// Render (or update in place) a progress-bar row: left label, fill track, right detail.
function renderBar(div, bar) {
  var left = div.querySelector('.bar-left');
  var fill = div.querySelector('.bar-fill');
  var right = div.querySelector('.bar-right');
  if (!left) {
    div.textContent = '';
    left = document.createElement('span'); left.className = 'bar-left';
    var track = document.createElement('div'); track.className = 'bar-track';
    fill = document.createElement('div'); fill.className = 'bar-fill';
    track.appendChild(fill);
    right = document.createElement('span'); right.className = 'bar-right';
    div.appendChild(left); div.appendChild(track); div.appendChild(right);
  }
  left.textContent = bar.left || '';
  right.textContent = bar.right || '';
  var pct = Math.max(0, Math.min(100, bar.pct || 0));
  fill.style.width = pct + '%';
}

// `status` drives the styling; `label` is what the badge reads. They differ for
// the queue, where the badge also carries the position but the class must not.
function setUpdateStatus(idx, status, label) {
  var el = document.getElementById('update-log-status-' + idx);
  if (!el) return;
  el.textContent = label || status;
  el.className = 'update-log-status update-status-' + status;
}

// Inline row progress bar (the seam between the result row and its detail row).
function showRowProgress(idx) {
  var bar = document.getElementById('row-progress-' + idx);
  if (!bar) return;
  bar.classList.remove('error');
  // 'waiting' shows a sweeping highlight until the first real progress arrives.
  bar.classList.add('active', 'waiting');
}

// Stop the indeterminate sweep once we have real progress to show.
function clearRowWaiting(idx) {
  var bar = document.getElementById('row-progress-' + idx);
  if (bar) bar.classList.remove('waiting');
}

function setRowProgress(idx, pct) {
  var fill = document.getElementById('row-progress-fill-' + idx);
  if (!fill) return;
  fill.style.width = Math.max(0, Math.min(100, pct || 0)) + '%';
}

// The pull is only part of an update; the bar fills to PULL_CAP during the pull
// and the passive steps (inspect/stop/rename/create/start/delete) creep it the
// rest of the way, so it reaches 100% only on success (or error).
var ROW_PROGRESS_PULL_CAP = 80;
var rowProgressState = {}; // idx -> { passive: bool, pct: number }

function rowProgressFor(idx) {
  return rowProgressState[idx] || (rowProgressState[idx] = { passive: false, pct: 0 });
}

// Drive the inline row bar from a streamed update log line.
function advanceRowProgress(idx, line) {
  var st = rowProgressFor(idx);
  if (line.id === 'pull-overall' && line.bar) {
    // Pull phase: scale the real pull pct into the 0..PULL_CAP band.
    clearRowWaiting(idx);
    st.pct = (line.bar.pct || 0) / 100 * ROW_PROGRESS_PULL_CAP;
    setRowProgress(idx, st.pct);
    // type 'ok' on the aggregate bar means every layer is done — pull is over.
    if (line.type === 'ok') st.passive = true;
    return;
  }
  if (line.bar) return; // per-layer bars don't drive the row bar
  // Plain messages only creep the bar once the pull has finished. Each passive
  // step nudges it asymptotically toward (but never quite to) 100%.
  if (!st.passive) return;
  clearRowWaiting(idx);
  st.pct = st.pct + (97 - st.pct) * 0.35;
  setRowProgress(idx, st.pct);
}

function hideRowProgress(idx) {
  var bar = document.getElementById('row-progress-' + idx);
  delete rowProgressState[idx];
  if (!bar) return;
  bar.classList.remove('active', 'error', 'waiting', 'queued');
  setRowProgress(idx, 0);
}

// Update failed: keep the bar visible and turn it red. The fill is driven to
// full width because this also runs on page load, where nothing has advanced
// the bar and a 0%-wide red fill would be invisible.
function errorRowProgress(idx) {
  var bar = document.getElementById('row-progress-' + idx);
  if (!bar) return;
  bar.classList.remove('waiting', 'queued');
  bar.classList.add('active', 'error');
  setRowProgress(idx, 100);
}

// Waiting in the retry queue: an indeterminate purple sweep, no percentage —
// nothing is happening for this container yet.
function queuedRowProgress(idx) {
  var bar = document.getElementById('row-progress-' + idx);
  if (!bar) return;
  bar.classList.remove('waiting', 'error');
  bar.classList.add('active', 'queued');
  setRowProgress(idx, 0);
}

// Coming back out of the queue (or starting fresh) — back to the normal bar.
function runningRowProgress(idx) {
  var bar = document.getElementById('row-progress-' + idx);
  if (!bar) return;
  bar.classList.remove('queued', 'error');
  bar.classList.add('active', 'waiting');
  rowProgressState[idx] = { passive: false, pct: 0 };
  setRowProgress(idx, 0);
}

function setUpdateButtonState(idx, state) {
  var btn = document.getElementById('btn-update-main-' + idx);
  if (!btn) return;
  if (state === 'running') {
    btn.classList.add('loading');
    btn.disabled = true;
  } else {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

function startUpdate(container, image, idx, event) {
  if (event) event.stopPropagation();

  showConfirmModal(
    'Update container <strong>' + esc(container) + '</strong> to newest image <strong>' + esc(image) + '</strong>?',
    function () {
      executeStartUpdate(container, image, idx);
    },
    { title: 'Update Container?', confirmText: 'Start Update' }
  );
}

function executeStartUpdate(container, image, idx) {
  // Don't auto-open the detail row; show inline progress on the row seam instead.
  showRowProgress(idx);
  rowProgressState[idx] = { passive: false, pct: 0 };
  setRowProgress(idx, 0);

  // Clear old log
  var logEl = document.getElementById('update-log-' + idx);
  if (logEl) logEl.innerHTML = '';
  setUpdateStatus(idx, 'running');
  setUpdateButtonState(idx, 'running');

  // POST to start update
  fetch('/api/update/' + encodeURIComponent(container), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: image })
  })
    .then(function (r) {
      if (r.status === 409) {
        addUpdateLog(idx, { msg: 'Update already in progress or queued, reconnecting…', type: 'warn' });
      } else if (!r.ok) {
        return r.json().then(function (d) {
          addUpdateLog(idx, { msg: 'Failed to start update: ' + (d.error || r.status), type: 'error' });
          setUpdateButtonState(idx, 'idle');
        });
      }
      // Open SSE stream
      subscribeUpdateStream(container, idx);
    })
    .catch(function (e) {
      addUpdateLog(idx, { msg: 'Network error: ' + e.message, type: 'error' });
      setUpdateButtonState(idx, 'idle');
    });
}

function subscribeUpdateStream(container, idx) {
  var src = new EventSource('/api/update/' + encodeURIComponent(container) + '/stream');

  src.addEventListener('log', function (e) {
    var line = JSON.parse(e.data);
    addUpdateLog(idx, line);
    advanceRowProgress(idx, line);
  });

  src.addEventListener('status', function (e) {
    var data = JSON.parse(e.data);

    // 'queued' and 'running' are intermediate: the server keeps the stream open
    // and the row just changes appearance.
    if (data.status === 'queued') {
      queuedRowProgress(idx);
      setUpdateStatus(idx, 'queued', data.queuePosition ? 'queued #' + data.queuePosition : 'queued');
      setUpdateButtonState(idx, 'running');
      return;
    }
    if (data.status === 'running') {
      runningRowProgress(idx);
      setUpdateStatus(idx, 'running');
      setUpdateButtonState(idx, 'running');
      return;
    }

    src.close();
    // 'none' means the server already forgot the update (it keeps a finished
    // one for 30s only); the persisted log still knows how it ended.
    if (data.status === 'none') { resolveFromUpdateLog(container); return; }
    finishRowUpdate(container, idx, data.status);
  });

  // The stream can drop while the update carries on server-side — most notably
  // when the container being updated is the reverse proxy this UI is reached
  // through. Giving up here would leave the row stuck on "running" forever, so
  // keep asking the server until it answers, then pick up where it is.
  src.onerror = function () {
    src.close();
    recoverUpdateStream(container, 0);
  };
}

function finishRowUpdate(container, idx, status) {
  setUpdateStatus(idx, status);
  setUpdateButtonState(idx, 'idle');

  if (status === 'done') {
    // Success: fill to 100% then fade the bar out.
    setRowProgress(idx, 100);
    setTimeout(function () { hideRowProgress(idx); }, 700);
    addLog('Update completed for ' + container, 'ok');
    refreshRowAfterUpdate(container, idx);
  } else {
    // Failure: leave the bar in place, turned red.
    errorRowProgress(idx);
    addLog('Update failed for ' + container, 'error');
  }
}

var UPDATE_RECOVER_DELAYS_MS = [1000, 2000, 5000, 10000];

function recoverUpdateStream(container, attempt) {
  var delay = UPDATE_RECOVER_DELAYS_MS[Math.min(attempt, UPDATE_RECOVER_DELAYS_MS.length - 1)];
  setTimeout(function () {
    fetch('/api/update-status')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (statuses) {
        // The table may have been re-rendered meanwhile, so look the row up again.
        var idx = getIdxByContainer(container);
        if (idx === null) return;
        var st = statuses && statuses[container];
        if (st && (st.status === 'running' || st.status === 'queued')) {
          // The stream replays the whole log, so start from an empty one.
          var logEl = document.getElementById('update-log-' + idx);
          if (logEl) logEl.innerHTML = '';
          rowProgressState[idx] = { passive: false, pct: 0 };
          subscribeUpdateStream(container, idx);
        } else if (st && (st.status === 'done' || st.status === 'failed')) {
          finishRowUpdate(container, idx, st.status);
        } else {
          resolveFromUpdateLog(container);
        }
      })
      .catch(function () { recoverUpdateStream(container, attempt + 1); });
  }, delay);
}

// Settle a row whose update is no longer tracked live, from the persisted log.
function resolveFromUpdateLog(container) {
  fetch('/api/update-logs')
    .then(function (r) { return r.json(); })
    .then(function (logs) {
      var idx = getIdxByContainer(container);
      if (idx === null) return;
      var entry = logs && logs[container];
      if (entry && (entry.status === 'done' || entry.status === 'failed')) {
        var logEl = document.getElementById('update-log-' + idx);
        if (logEl) logEl.innerHTML = '';
        (entry.log || []).forEach(function (line) { addUpdateLog(idx, line); });
        finishRowUpdate(container, idx, entry.status);
      } else {
        hideRowProgress(idx);
        setUpdateButtonState(idx, 'idle');
      }
    })
    .catch(function () {
      var idx = getIdxByContainer(container);
      if (idx !== null) { hideRowProgress(idx); setUpdateButtonState(idx, 'idle'); }
    });
}

// Restore persisted update logs into the detail rows
function restoreUpdateLogs() {
  fetch('/api/update-logs')
    .then(function (r) { return r.json(); })
    .then(function (logs) {
      if (!logs) return;
      for (var container in logs) {
        if (!logs.hasOwnProperty(container)) continue;
        var idx = getIdxByContainer(container);
        if (idx === null) continue;
        var entry = logs[container];
        var logEl = document.getElementById('update-log-' + idx);
        if (logEl) logEl.innerHTML = '';
        if (entry.log && entry.log.length) {
          var wrapEl = document.getElementById('update-log-wrap-' + idx);
          if (wrapEl) wrapEl.style.display = '';
          for (var i = 0; i < entry.log.length; i++) {
            addUpdateLog(idx, entry.log[i]);
          }
        }
        setUpdateStatus(idx, entry.status);
        // A failed update keeps its red seam bar across reloads until it is
        // superseded — the server marks the entry resolved once the container's
        // image digest or container id has moved on (including an update done
        // outside this tool), and only then does the bar go away.
        if (entry.status === 'failed' && !entry.resolved) errorRowProgress(idx);
      }
    })
    .catch(function () { });
}

// Reconnect SSE for containers that have an active update
function reconnectActiveUpdates() {
  fetch('/api/update-status')
    .then(function (r) { return r.json(); })
    .then(function (statuses) {
      if (!statuses) return;
      for (var container in statuses) {
        if (!statuses.hasOwnProperty(container)) continue;
        var st = statuses[container].status;
        if (st === 'running' || st === 'queued') {
          var idx = getIdxByContainer(container);
          if (idx === null) continue;
          if (st === 'queued') {
            queuedRowProgress(idx);
            setUpdateStatus(idx, 'queued', statuses[container].queuePosition ? 'queued #' + statuses[container].queuePosition : 'queued');
          } else {
            showRowProgress(idx);
            setUpdateStatus(idx, 'running');
          }
          setUpdateButtonState(idx, 'running');
          subscribeUpdateStream(container, idx);
        }
      }
    })
    .catch(function (e) { });
}

// Bring one row up to date after its container was updated: repaint the status
// badge and drop the Update button, then reload the values the server refreshed
// in the cache (digest, version, state). Only this row's cells are touched, so
// an expanded detail panel and its update log stay where they are.
function refreshRowAfterUpdate(container, idx) {
  var tr = document.querySelector('tr.result-row[data-idx="' + idx + '"]');
  if (tr) {
    tr.dataset.result = 'UpToDate';
    tr.classList.remove('row-outdated');
    var badge = tr.querySelector('.result-badge');
    if (badge) {
      badge.className = 'result-badge result-UpToDate';
      badge.innerHTML = '<span class="dot"></span><span class="result-full">Up to date</span><span class="result-short">👍</span>';
    }
    var actions = tr.querySelector('.col-actions');
    if (actions) actions.innerHTML = '';
  }
  var detailBadge = document.getElementById('detail-badge-' + idx);
  if (detailBadge) {
    detailBadge.className = 'result-badge result-UpToDate';
    detailBadge.innerHTML = '<span class="dot"></span>Up to date';
  }
  var detailRow = document.getElementById('detail-' + idx);
  if (detailRow) detailRow.classList.remove('row-outdated');

  var row = rowByKey(idx);
  if (row) row.result = 'UpToDate';
  updateStats();

  refreshRowValues(container, idx);
}

// After a successful update the server has already refreshed the cache (digest,
// version, state) — read it back so a UI left open does not keep showing the old
// values until the next full scan. Only the affected row's cells are rewritten,
// so an expanded detail panel and its update log stay in place.
function refreshRowValues(container, idx) {
  fetch('/api/last-result')
    .then(function (r) { return r.json(); })
    .then(function (cache) {
      if (!cache || !cache.results) return;
      var fresh = null;
      for (var i = 0; i < cache.results.length; i++) {
        if (cache.results[i].container === container) { fresh = cache.results[i]; break; }
      }
      if (!fresh) return;

      var row = rowByKey(idx);
      if (!row || row.container !== container) return;

      row.localVersion = fresh.localVersion;
      row.remoteVersion = fresh.remoteVersion;
      row.localDigest = fresh.localDigest;
      row.remoteDigest = fresh.remoteDigest;
      row.state = fresh.state;
      row.status = fresh.status;
      row.result = fresh.result;

      setCellText('cell-localver-' + idx, fresh.localVersion || '-');
      setCellText('cell-remotever-' + idx, fresh.remoteVersion || '-');
      setCellText('detail-localver-' + idx, fresh.localVersion || '-');
      setCellText('detail-remotever-' + idx, fresh.remoteVersion || '-');
      setCellText('detail-localdigest-' + idx, fresh.localDigest);
      setCellText('detail-remotedigest-' + idx, fresh.remoteDigest);

      var stateClass = fresh.state === 'running' ? 'state-running'
        : fresh.state === 'exited' ? 'state-exited'
          : 'state-other';
      var dotClass = fresh.state === 'running' ? 'state-dot-running'
        : fresh.state === 'exited' ? 'state-dot-exited'
          : 'state-dot-other';
      var stateIds = ['cell-state-' + idx, 'detail-state-' + idx];
      for (var j = 0; j < stateIds.length; j++) {
        var el = document.getElementById(stateIds[j]);
        if (!el) continue;
        el.className = 'state-badge ' + stateClass;
        el.textContent = fresh.state == null ? '' : String(fresh.state);
      }
      var dot = document.getElementById('cell-statedot-' + idx);
      if (dot) dot.className = 'state-dot-mobile ' + dotClass;

      updateLastCheckedLabel(cache.timestamp);
    })
    .catch(function () { });
}

function setCellText(id, value) {
  var el = document.getElementById(id);
  if (el) el.textContent = value == null ? '' : String(value);
}
