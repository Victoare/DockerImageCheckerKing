// =========================================================================
// Theme
// =========================================================================
var THEME_KEY = 'docker-checker-theme';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

function setThemeMode(mode) {
  document.documentElement.setAttribute('data-theme-mode', mode);
  if (mode === 'auto') {
    localStorage.removeItem(THEME_KEY);
    applyTheme(window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  } else {
    localStorage.setItem(THEME_KEY, mode);
    applyTheme(mode);
  }
}

function toggleTheme() {
  var mode = document.documentElement.getAttribute('data-theme-mode') || 'auto';
  var next = mode === 'auto' ? 'dark' : mode === 'dark' ? 'light' : 'auto';
  setThemeMode(next);
}

window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function (e) {
  if (!localStorage.getItem(THEME_KEY)) {
    applyTheme(e.matches ? 'light' : 'dark');
  }
});

// =========================================================================
// App state
// =========================================================================
var APP = {
  results: [],
  filter: 'all',
  nextCheckIso: null,
  countdownInterval: null,
  logPanelOpen: true,
  modalCallback: null
};

// Every row gets a key that stays with it for as long as the row exists. It is
// deliberately NOT the array position: the table is re-sorted and re-rendered
// while updates are running, and a position-derived key silently pointed the
// DOM ids (and the update progress state) at a different container.
var nextRowKey = 1;

function rowKey(row) {
  if (!row.__key) row.__key = nextRowKey++;
  return row.__key;
}

function rowByKey(key) {
  for (var i = 0; i < APP.results.length; i++) {
    if (String(APP.results[i].__key) === String(key)) return APP.results[i];
  }
  return null;
}

// =========================================================================
// Utility
// =========================================================================
function esc(s) {
  var d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

// =========================================================================
// Log panel
// =========================================================================
function toggleLogPanel() {
  APP.logPanelOpen = !APP.logPanelOpen;
  document.getElementById('logContent').style.display = APP.logPanelOpen ? '' : 'none';
  document.getElementById('logToggleIcon').style.transform = APP.logPanelOpen ? '' : 'rotate(-90deg)';
}
function collapseLogPanel() {
  APP.logPanelOpen = false;
  document.getElementById('logContent').style.display = 'none';
  document.getElementById('logToggleIcon').style.transform = 'rotate(-90deg)';
}

function addLog(msg, type) {
  var el = document.getElementById('logContent');
  var line = document.createElement('div');
  line.className = 'log-line' + (type ? ' ' + type : '');
  line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

// =========================================================================
// Modal logic
// =========================================================================
function showConfirmModal(html, callback, opts) {
  opts = opts || {};
  document.getElementById('confirmModalIcon').textContent = opts.icon || '⚠️';
  document.getElementById('confirmModalTitle').textContent = opts.title || 'Confirm';
  document.getElementById('confirmModalText').innerHTML = html;
  document.getElementById('confirmBtn').textContent = opts.confirmText || 'Confirm';
  APP.modalCallback = callback;
  var modal = document.getElementById('confirmModal');
  modal.style.display = 'flex';
  document.body.classList.add('modal-open');
  setTimeout(function () { modal.classList.add('visible'); }, 10);
}

function closeConfirmModal(confirmed) {
  var modal = document.getElementById('confirmModal');
  modal.classList.remove('visible');
  setTimeout(function () {
    modal.style.display = 'none';
    document.body.classList.remove('modal-open');
    if (confirmed && APP.modalCallback) APP.modalCallback();
    APP.modalCallback = null;
  }, 300);
}

// Close modal on escape or backdrop click
window.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') {
    // Close only the topmost modal
    var tmpl = document.getElementById('templateModal');
    if (tmpl.classList.contains('visible')) { closeTemplateEditor(); return; }
    closeConfirmModal(false); closeSettingsModal(); closeCnotifyModal();
  }
});
document.getElementById('confirmModal').addEventListener('click', function (e) {
  if (e.target === this) closeConfirmModal(false);
});
document.getElementById('settingsModal').addEventListener('click', function (e) {
  if (e.target === this) closeSettingsModal();
});
document.getElementById('cnotifyModal').addEventListener('click', function (e) {
  if (e.target === this) closeCnotifyModal();
});

// =========================================================================
// Init
// =========================================================================
fetch('/api/version').then(function(r){return r.json();}).then(function(d){
  if(d&&d.version)document.getElementById('appVersion').textContent='v'+d.version;
}).catch(function(){});
