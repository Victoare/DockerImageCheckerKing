// =========================================================================
// Check Images
// =========================================================================
function startCheck() {
  var btn = document.getElementById('btnCheck');

  btn.classList.add('loading');
  btn.disabled = true;

  APP.results = [];
  document.getElementById('resultsBody').innerHTML = '';
  document.getElementById('progressArea').classList.add('visible');
  document.getElementById('statsArea').classList.remove('visible');

  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('logPanel').classList.add('visible');
  document.getElementById('logContent').innerHTML = '';
  updateStats();
  setProgress(0, 0);

  var evtSource = new EventSource('/api/check?includeStopped=true');
  var total = 0;

  evtSource.addEventListener('total', function (e) {
    var data = JSON.parse(e.data);
    total = data.count;
    addLog('Found ' + total + ' container(s) to check.', 'ok');
  });

  evtSource.addEventListener('progress', function (e) {
    var data = JSON.parse(e.data);
    setProgress(data.index, data.total);
    document.getElementById('progressLabel').textContent = 'Checking ' + data.container + '...';
    addLog('Checking: ' + data.container + ' (' + data.image + ')');
  });

  evtSource.addEventListener('result', function (e) {
    var row = JSON.parse(e.data);
    APP.results.push(row);
    appendRow(row, APP.results.length);
    updateStats();
  });

  evtSource.addEventListener('done', function (e) {
    evtSource.close();
    btn.classList.remove('loading');
    btn.disabled = false;
    setProgress(total, total);
    document.getElementById('progressArea').classList.remove('visible');
    document.getElementById('statsArea').classList.add('visible');
    sortResults();
    renderAllRows();
    updateLastCheckedLabel(new Date().toISOString());
    fetchNextCheck();
    fetchRateLimits();

    var outdated = APP.results.filter(function (r) { return r.result === 'Outdated'; }).length;
    if (outdated > 0) {
      addLog('Finished. ' + outdated + ' container(s) need updating.', 'warn');
    } else {
      addLog('Finished. All containers are up to date!', 'ok');
    }

    // Restore any persisted update logs into the detail rows
    restoreUpdateLogs();
    // Reconnect to any active updates
    reconnectActiveUpdates();
    // Refresh bell icon states after table rebuild
    loadAllCnotifyStates();

    // Collapse log if everything is OK (no outdated, no unknown)
    var unknown = APP.results.filter(function (r) { return r.result === 'Unknown'; }).length;
    if (outdated === 0 && unknown === 0) {
      collapseLogPanel();
    }
  });

  evtSource.addEventListener('error', function (e) {
    if (e.data) {
      var data = JSON.parse(e.data);
      addLog('Error: ' + data.message, 'error');
    }
    evtSource.close();
    btn.classList.remove('loading');
    btn.disabled = false;
  });

  evtSource.onerror = function () {
    evtSource.close();
    btn.classList.remove('loading');
    btn.disabled = false;
    addLog('Connection lost.', 'error');
  };
}

var STATE_ORDER = { running: 0, created: 1, exited: 2 };
var RESULT_ORDER = { Outdated: 0, UpToDate: 1, Unknown: 2, NoLocalDigest: 3, Pinned: 4 };

function sortResults() {
  APP.results.sort(function (a, b) {
    var na = a.notifyState === 'disabled' ? 1 : 0;
    var nb = b.notifyState === 'disabled' ? 1 : 0;
    if (na !== nb) return na - nb;
    var ra = RESULT_ORDER[a.result] !== undefined ? RESULT_ORDER[a.result] : 9;
    var rb = RESULT_ORDER[b.result] !== undefined ? RESULT_ORDER[b.result] : 9;
    if (ra !== rb) return ra - rb;
    var sa = STATE_ORDER[a.state] !== undefined ? STATE_ORDER[a.state] : 9;
    var sb = STATE_ORDER[b.state] !== undefined ? STATE_ORDER[b.state] : 9;
    if (sa !== sb) return sa - sb;
    return a.container.localeCompare(b.container);
  });
}

function renderAllRows() {
  document.getElementById('resultsBody').innerHTML = '';
  for (var i = 0; i < APP.results.length; i++) appendRow(APP.results[i], i + 1);
  updateStats();
  filterRows(APP.filter);
}

function setProgress(current, total) {
  var pct = total > 0 ? Math.round((current / total) * 100) : 0;
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressCount').textContent = current + ' / ' + total;
}

function updateStats() {
  var counts = { UpToDate: 0, Outdated: 0, Unknown: 0 };
  APP.results.forEach(function (r) {
    if (counts.hasOwnProperty(r.result)) counts[r.result]++;
  });
  document.getElementById('statUpToDate').textContent = counts.UpToDate;
  document.getElementById('statOutdated').textContent = counts.Outdated;
  document.getElementById('statUnknown').textContent = counts.Unknown;
  document.getElementById('statTotal').textContent = APP.results.length;
}

function appendRow(row, idx) {
  var tbody = document.getElementById('resultsBody');
  var stateClass = row.state === 'running' ? 'state-running'
    : row.state === 'exited' ? 'state-exited'
      : 'state-other';
  var resultLabels = {
    UpToDate: 'Up to date', Outdated: 'Outdated', Unknown: 'Unknown',
    Pinned: 'Pinned', NoLocalDigest: 'No digest'
  };
  var resultShort = {
    UpToDate: '👍', Outdated: '👴', Unknown: '🤷', Pinned: '📌', NoLocalDigest: '?'
  };

  var tr = document.createElement('tr');
  tr.className = 'result-row';
  tr.dataset.result = row.result;
  tr.dataset.idx = idx;
  tr.dataset.container = row.container;
  tr.dataset.image = row.image;
  if (row.result === 'Outdated') tr.classList.add('row-outdated');
  if (row.result === 'Unknown') tr.classList.add('row-unknown');
  if (APP.filter !== 'all' && row.result !== APP.filter) tr.style.display = 'none';

  var dotClass = row.state === 'running' ? 'state-dot-running' : row.state === 'exited' ? 'state-dot-exited' : 'state-dot-other';

  var updateBtnMain = '';
  if (row.result === 'Outdated') {
    updateBtnMain =
      '<button class="btn-update-inline" id="btn-update-main-' + idx + '" onclick="startUpdate(\'' + esc(row.container) + '\', \'' + esc(row.image) + '\', ' + idx + ', event)">' +
      '<span class="update-spinner"></span><span class="update-btn-icon">⬆</span><span class="update-text"> Update</span></button>';
  }

  tr.innerHTML =
    '<td class="col-expand"><button class="expand-btn" id="expand-' + idx + '" onclick="toggleDetail(' + idx + ')">&#8250;</button></td>' +
    '<td class="col-state"><span class="state-dot-mobile ' + dotClass + '"></span><span class="state-badge ' + stateClass + '">' + esc(row.state) + '</span></td>' +
    '<td class="col-container"><span class="container-name">' + esc(row.container) + '</span></td>' +
    '<td class="col-registry"><span style="font-family:\'JetBrains Mono\',monospace;font-size:11px;color:var(--text-dim);">' + esc(row.registry) + '</span></td>' +
    '<td class="col-image"><span class="image-name">' + esc(row.image) + '</span></td>' +
    '<td class="col-tag"><span style="font-family:\'JetBrains Mono\',monospace;font-size:11px;">' + esc(row.tag) + '</span></td>' +
    '<td class="col-status"><span class="result-badge result-' + row.result + '"><span class="dot"></span><span class="result-full">' + (resultLabels[row.result] || row.result) + '</span><span class="result-short">' + (resultShort[row.result] || '?') + '</span></span></td>' +
    '<td class="col-actions">' + updateBtnMain + '</td>' +
    '<td class="col-notify"><button class="cnotify-bell-btn" id="cnotify-btn-' + idx + '" onclick="openContainerNotifyModal(\'' + esc(row.container) + '\', ' + idx + ')" title="Notification settings">' +
      '<span class="cnotify-icon" id="cnotify-icon-' + idx + '">' +
        '<svg class="cnotify-bell" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>' +
        '<svg class="cnotify-bell-off" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M1 1l22 22"/></svg>' +
        '<span class="cnotify-badge"></span>' +
      '</span>' +
    '</button></td>';
  tbody.appendChild(tr);

  // Apply notify state from server
  if (row.notifyState === 'disabled') {
    var ni = document.getElementById('cnotify-icon-' + idx);
    var nb = document.getElementById('cnotify-btn-' + idx);
    if (ni) ni.classList.add('cnotify-disabled');
    if (nb) nb.classList.add('cnotify-state-disabled');
  } else if (row.notifyState === 'customized') {
    var ni2 = document.getElementById('cnotify-icon-' + idx);
    if (ni2) ni2.classList.add('cnotify-customized');
  }

  // Detail row
  var dr = document.createElement('tr');
  dr.className = 'detail-row';
  dr.id = 'detail-' + idx;
  if (row.result === 'Outdated') dr.classList.add('row-outdated');
  if (row.result === 'Unknown') dr.classList.add('row-unknown');

  // Build update button HTML (only for Outdated)
  var updateBtnHtml = '';
  if (row.result === 'Outdated') {
    updateBtnHtml =
      '<div class="update-action">' +
      '<button class="btn-update" id="btn-update-' + idx + '" onclick="startUpdate(\'' + esc(row.container) + '\', \'' + esc(row.image) + '\', ' + idx + ')">' +
      '<span class="update-spinner"></span>' +
      '<span class="update-btn-icon">⬆</span> Update' +
      '</button>' +
      '</div>';
  }

  dr.innerHTML =
    '<td colspan="9" class="detail-cell">' +
    '<div class="detail-content">' +
    '<div class="detail-item detail-registry"><span class="detail-label">Registry</span><span class="detail-value" style="font-family:\'JetBrains Mono\',monospace;font-size:11px;color:var(--text-dim);">' + esc(row.registry) + '</span></div>' +
    '<div class="detail-item detail-image"><span class="detail-label">Image</span><span class="detail-value"><span class="image-name">' + esc(row.image) + '</span></span></div>' +
    '<div class="detail-item detail-tag"><span class="detail-label">Tag</span><span class="detail-value" style="font-family:\'JetBrains Mono\',monospace;font-size:11px;">' + esc(row.tag) + '</span></div>' +
    '<div class="detail-item detail-state"><span class="detail-label">State</span><span class="detail-value"><span class="state-badge ' + stateClass + '">' + esc(row.state) + '</span></span></div>' +
    '<div class="detail-item detail-status"><span class="detail-label">Status</span><span class="detail-value"><span class="result-badge result-' + row.result + '" id="detail-badge-' + idx + '"><span class="dot"></span>' + (resultLabels[row.result] || row.result) + '</span></span></div>' +
    '<div class="detail-item"><span class="detail-label">Local Digest</span><span class="detail-value digest-val">' + esc(row.localDigest) + '</span></div>' +
    '<div class="detail-item"><span class="detail-label">Remote Digest</span><span class="detail-value digest-val">' + esc(row.remoteDigest) + '</span></div>' +
    '</div>' +
    '<div class="update-log-wrap" id="update-log-wrap-' + idx + '" style="display:none">' +
    '<div class="update-log-header"><span class="update-log-title">Update Log</span><span class="update-log-status" id="update-log-status-' + idx + '"></span></div>' +
    '<div class="update-log" id="update-log-' + idx + '"></div>' +
    '</div>' +
    '</td>';
  tbody.appendChild(dr);
}

function toggleDetail(idx) {
  var detail = document.getElementById('detail-' + idx);
  var btn = document.getElementById('expand-' + idx);
  var isOpen = detail.style.display === 'table-row';
  detail.style.display = isOpen ? 'none' : 'table-row';
  btn.classList.toggle('open', !isOpen);
}

function filterRows(filter) {
  APP.filter = filter;

  var cards = document.querySelectorAll('.stat-card');
  for (var k = 0; k < cards.length; k++) cards[k].classList.remove('active-filter');
  var filterToCard = { 'UpToDate': 'up-to-date', 'Outdated': 'outdated', 'Unknown': 'unknown', 'all': 'total' };
  if (filterToCard[filter]) {
    var activeCard = document.querySelector('.stat-card.' + filterToCard[filter]);
    if (activeCard) activeCard.classList.add('active-filter');
  }

  var rows = document.querySelectorAll('#resultsBody tr.result-row');
  for (var j = 0; j < rows.length; j++) {
    var show = filter === 'all' || rows[j].dataset.result === filter;
    rows[j].style.display = show ? '' : 'none';
    var detail = document.getElementById('detail-' + rows[j].dataset.idx);
    if (detail && !show) detail.style.display = 'none';
  }
}

function updateLastCheckedLabel(isoString) {
  var el = document.getElementById('lastCheckedLabel');
  var date = new Date(isoString);
  el.textContent = 'Last checked: ' + date.toLocaleString();
  el.classList.add('visible');
}

function restoreLastResult() {
  fetch('/api/last-result')
    .then(function (r) { return r.json(); })
    .then(function (cache) {
      if (!cache || !cache.results || !cache.results.length) return;
      APP.results = cache.results;
      document.getElementById('statsArea').classList.add('visible');
      document.getElementById('emptyState').style.display = 'none';
      sortResults();
      renderAllRows();
      updateLastCheckedLabel(cache.timestamp);

      // Restore persisted update logs + reconnect to any active updates
      restoreUpdateLogs();
      reconnectActiveUpdates();
    })
    .catch(function () { });
}

restoreLastResult();

// =========================================================================
// Auto-check countdown
// =========================================================================
function fetchNextCheck() {
  fetch('/api/next-check')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data || !data.nextAutoCheck) return;
      APP.nextCheckIso = data.nextAutoCheck;
      startCountdown();
    })
    .catch(function () { });
}

function startCountdown() {
  if (APP.countdownInterval) clearInterval(APP.countdownInterval);
  updateCountdownLabel();
  APP.countdownInterval = setInterval(function () {
    updateCountdownLabel();
  }, 1000);
}

function updateCountdownLabel() {
  var el = document.getElementById('nextCheckLabel');
  if (!APP.nextCheckIso) { el.classList.remove('visible'); return null; }
  var remaining = new Date(APP.nextCheckIso).getTime() - Date.now();
  if (remaining <= 0) {
    el.textContent = 'Auto-check running…';
    el.classList.add('visible');
    return 0;
  }
  var h = Math.floor(remaining / 3600000);
  var m = Math.floor((remaining % 3600000) / 60000);
  var s = Math.floor((remaining % 60000) / 1000);
  var parts = [];
  if (h > 0) parts.push(h + 'h');
  if (m > 0) parts.push(m + 'm');
  parts.push(s + 's');
  el.textContent = 'Next auto-check: ' + parts.join(' ');
  el.classList.add('visible');
  return remaining;
}

function reloadResults() {
  fetch('/api/last-result')
    .then(function (r) { return r.json(); })
    .then(function (cache) {
      if (!cache || !cache.results || !cache.results.length) return;
      APP.results = cache.results;
      document.getElementById('statsArea').classList.add('visible');
      document.getElementById('emptyState').style.display = 'none';
      sortResults();
      renderAllRows();
      updateLastCheckedLabel(cache.timestamp);
      restoreUpdateLogs();
      reconnectActiveUpdates();
    })
    .catch(function () { });
}

fetchNextCheck();

// =========================================================================
// Rate limits display
// =========================================================================
function fetchRateLimits() {
  fetch('/api/rate-limits')
    .then(function (r) { return r.json(); })
    .then(function (limits) {
      if (!limits || Object.keys(limits).length === 0) return;
      var container = document.getElementById('rateLimits');
      container.innerHTML = '';
      for (var registry in limits) {
        if (!limits.hasOwnProperty(registry)) continue;
        var info = limits[registry];
        if (info.limit === null && info.remaining === null) continue;
        var pct = (info.limit && info.remaining !== null) ? Math.round((info.remaining / info.limit) * 100) : 100;
        // Only show when rate limit is below 80% (matches server's fast/slow threshold)
        if (pct >= 80) continue;
        var color = pct > 50 ? 'var(--green)' : pct > 20 ? 'var(--yellow)' : 'var(--red)';
        var item = document.createElement('div');
        item.className = 'rate-limit-item';
        item.innerHTML =
          '<span class="rate-limit-registry">' + esc(registry) + '</span>' +
          '<div class="rate-limit-bar"><div class="rate-limit-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
          '<span>' + (info.remaining !== null ? info.remaining : '?') + ' / ' + (info.limit !== null ? info.limit : '?') + '</span>';
        container.appendChild(item);
      }
      container.classList.add('visible');
    })
    .catch(function () { });
}

fetchRateLimits();

// =========================================================================
// Server-sent events for auto-check notifications
// =========================================================================
(function connectEventStream() {
  var src = new EventSource('/api/events');

  src.addEventListener('auto-check-start', function () {
    var el = document.getElementById('nextCheckLabel');
    el.textContent = 'Auto-check running\u2026';
    el.classList.add('visible');
  });

  src.addEventListener('auto-check-done', function (e) {
    var data = JSON.parse(e.data);
    if (!data.error) {
      reloadResults();
      addLog('Auto-check completed (' + data.count + ' containers).', 'ok');
    } else {
      addLog('Auto-check failed: ' + data.error, 'error');
    }
    fetchNextCheck();
    fetchRateLimits();
  });

  src.onerror = function () {
    src.close();
    setTimeout(connectEventStream, 10000);
  };
})();
