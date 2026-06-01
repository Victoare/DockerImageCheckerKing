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

function setUpdateStatus(idx, status) {
  var el = document.getElementById('update-log-status-' + idx);
  if (!el) return;
  el.textContent = status;
  el.className = 'update-log-status update-status-' + status;
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
  // Show detail row if not open
  var detail = document.getElementById('detail-' + idx);
  if (detail && detail.style.display !== 'table-row') {
    toggleDetail(idx);
  }

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
        addUpdateLog(idx, { msg: 'Update already in progress, reconnecting…', type: 'warn' });
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
  });

  src.addEventListener('status', function (e) {
    var data = JSON.parse(e.data);
    src.close();
    if (data.status === 'none') {
      return;
    }
    setUpdateStatus(idx, data.status);
    setUpdateButtonState(idx, 'idle');

    if (data.status === 'done') {
      addLog('Update completed for ' + container, 'ok');
      updateRowToUpToDate(idx);
    } else {
      addLog('Update failed for ' + container, 'error');
    }
  });

  src.onerror = function () {
    src.close();
    setUpdateButtonState(idx, 'idle');
  };
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
        if (statuses[container].status === 'running') {
          var idx = getIdxByContainer(container);
          if (idx === null) continue;
          var detail = document.getElementById('detail-' + idx);
          if (detail && detail.style.display !== 'table-row') toggleDetail(idx);

          setUpdateButtonState(idx, 'running');
          setUpdateStatus(idx, 'running');
          subscribeUpdateStream(container, idx);
        }
      }
    })
    .catch(function (e) { });
}

function updateRowToUpToDate(idx) {
  var row = APP.results.find(function (r, i) { return (i + 1) == idx; });
  if (!row) return;

  row.result = 'UpToDate';
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
  updateStats();
}
