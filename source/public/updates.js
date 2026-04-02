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

  var div = document.createElement('div');
  div.className = 'update-log-line' + (line.type ? ' ' + line.type : '');
  var ts = line.time ? '[' + new Date(line.time).toLocaleTimeString() + '] ' : '';
  div.textContent = ts + line.msg;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
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
