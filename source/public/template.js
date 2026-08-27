// =========================================================================
// Template Editor
// =========================================================================
// Three separate messages share one editor. All of them are loaded up front and
// held in memory, so switching tabs never loses an unsaved edit and Save can
// write back only the ones that actually changed.
var TMPL_KINDS = ['outdated', 'updateSuccess', 'updateFail'];
var tmplKind = 'outdated';
var tmplDefaults = {};
var tmplBuffers = {};
var tmplOriginals = {};

// Editing the outdated alert previews against a real row; the update reports
// preview against the same row plus the timing tokens an update supplies.
var tmplDefault = '';

function openTemplateEditor() {
  Promise.all(TMPL_KINDS.map(function (kind) {
    return fetch('/api/telegram/template?kind=' + kind).then(function (r) { return r.json(); });
  }))
    .then(function (all) {
      for (var i = 0; i < TMPL_KINDS.length; i++) {
        var kind = TMPL_KINDS[i];
        tmplDefaults[kind] = all[i].default || '';
        tmplOriginals[kind] = all[i].template || tmplDefaults[kind];
        tmplBuffers[kind] = tmplOriginals[kind];
      }
      tmplKind = 'outdated';
      tmplDefault = tmplDefaults[tmplKind];
      document.getElementById('tmplEditor').value = tmplBuffers[tmplKind];
      tmplRenderTabs();
      tmplPopulateContainerSelect();
      tmplPopulateChatSelect();
      tmplUpdatePreview();
      var modal = document.getElementById('templateModal');
      modal.style.display = 'flex';
      document.body.classList.add('modal-open');
      setTimeout(function () { modal.classList.add('visible'); }, 10);
    });
}

// Switch which message is being edited, keeping the current buffer.
function tmplSelectKind(kind) {
  if (kind === tmplKind) return;
  tmplBuffers[tmplKind] = document.getElementById('tmplEditor').value;
  tmplKind = kind;
  tmplDefault = tmplDefaults[kind];
  document.getElementById('tmplEditor').value = tmplBuffers[kind] || '';
  tmplRenderTabs();
  tmplUpdatePreview();
}

function tmplRenderTabs() {
  var tabs = document.querySelectorAll('#tmplTabs .tmpl-tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle('active', tabs[i].getAttribute('data-kind') === tmplKind);
  }
}

function closeTemplateEditor() {
  var modal = document.getElementById('templateModal');
  modal.classList.remove('visible');
  setTimeout(function () {
    modal.style.display = 'none';
    document.body.classList.remove('modal-open');
  }, 300);
}

function tmplPopulateContainerSelect() {
  var sel = document.getElementById('tmplPreviewSelect');
  sel.innerHTML = '<option value="__mock__">Mock data</option>';
  for (var i = 0; i < APP.results.length; i++) {
    var r = APP.results[i];
    var opt = document.createElement('option');
    opt.value = r.container;
    opt.textContent = r.container;
    sel.appendChild(opt);
  }
}

function tmplPopulateChatSelect() {
  var sel = document.getElementById('tmplSendChat');
  sel.innerHTML = '';
  var chats = telegramConfig.chats || [];
  if (chats.length === 0) {
    var opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No chats configured';
    sel.appendChild(opt);
    return;
  }
  for (var i = 0; i < chats.length; i++) {
    var opt = document.createElement('option');
    opt.value = chats[i].chatId;
    opt.textContent = chats[i].name || chats[i].chatId;
    sel.appendChild(opt);
  }
}

var TMPL_MOCK = {
  container: 'my-awesome-app', image: 'nginx:latest', registry: 'docker.io',
  tag: 'latest', state: 'running', status: 'Up 3 days',
  localDigest: 'sha256:abc123...', remoteDigest: 'sha256:def456...',
  localVersion: '1.25.3', remoteVersion: '1.25.4',
  startedAt: '2025-01-01 12:00:00', finishedAt: '2025-01-01 12:02:31',
  error: 'Docker request timeout after 600s of silence: POST /images/create'
};

function tmplRenderPreview(template, data) {
  var has = function (name) {
    var v = data[name];
    return v !== undefined && v !== null && v !== '' && v !== '-';
  };
  var out = template.replace(/\{\?(\w+)\}([\s\S]*?)\{\/\}/g, function (_, name, inner) {
    return has(name) ? inner : '';
  });
  return out.replace(/\{(\w+)\}/g, function (m, name) {
    if (data.hasOwnProperty(name)) return has(name) ? data[name] : '';
    return m;
  }).trim();
}

function tmplUpdatePreview() {
  var template = document.getElementById('tmplEditor').value;
  var sel = document.getElementById('tmplPreviewSelect').value;
  var data = TMPL_MOCK;
  if (sel !== '__mock__') {
    var row = APP.results.find(function (r) { return r.container === sel; });
    if (row) {
      // A cached row has no update timing on it; borrow the mock values so the
      // update templates still render something meaningful in the preview.
      data = Object.assign({}, row, {
        startedAt: TMPL_MOCK.startedAt, finishedAt: TMPL_MOCK.finishedAt,
        error: tmplKind === 'updateFail' ? TMPL_MOCK.error : ''
      });
    }
  }
  var rendered = tmplRenderPreview(template, data);
  document.getElementById('tmplPreview').innerHTML = rendered.replace(/\n/g, '<br>');
}

// Use mousedown + preventDefault to keep textarea selection alive
document.getElementById('tmplToolbar').addEventListener('mousedown', function (e) {
  var btn = e.target.closest('.tmpl-tb-btn');
  if (!btn) return;
  e.preventDefault();
  var wrap = btn.getAttribute('data-wrap');
  var ins = btn.getAttribute('data-insert');
  var ta = document.getElementById('tmplEditor');
  var start = ta.selectionStart, end = ta.selectionEnd;
  var val = ta.value;
  if (wrap) {
    var parts = wrap.split('|');
    var open = parts[0], close = parts[1];
    var selected = val.substring(start, end);
    ta.value = val.substring(0, start) + open + selected + close + val.substring(end);
    ta.selectionStart = start + open.length;
    ta.selectionEnd = start + open.length + selected.length;
  } else if (ins) {
    ta.value = val.substring(0, start) + ins + val.substring(end);
    ta.selectionStart = ta.selectionEnd = start + ins.length;
  }
  tmplUpdatePreview();
});

function tmplResetDefault() {
  document.getElementById('tmplEditor').value = tmplDefaults[tmplKind] || '';
  tmplUpdatePreview();
}

function saveTemplate() {
  tmplBuffers[tmplKind] = document.getElementById('tmplEditor').value;
  var changed = TMPL_KINDS.filter(function (kind) {
    return tmplBuffers[kind] !== tmplOriginals[kind];
  });
  if (!changed.length) { closeTemplateEditor(); return; }
  Promise.all(changed.map(function (kind) {
    return fetch('/api/telegram/template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: tmplBuffers[kind], kind: kind })
    }).then(function (r) { return r.json(); });
  }))
    .then(function (results) {
      var bad = results.filter(function (d) { return !d.ok; });
      if (bad.length) { alert('Failed to save: ' + JSON.stringify(bad)); return; }
      for (var i = 0; i < changed.length; i++) tmplOriginals[changed[i]] = tmplBuffers[changed[i]];
      closeTemplateEditor();
    })
    .catch(function (e) { alert('Error: ' + e.message); });
}

function tmplSendTest() {
  var chatId = document.getElementById('tmplSendChat').value;
  if (!chatId) { alert('No chat selected'); return; }
  var template = document.getElementById('tmplEditor').value;
  var sel = document.getElementById('tmplPreviewSelect').value;
  var container = sel !== '__mock__' ? sel : null;
  var btn = document.getElementById('tmplSendBtn');
  btn.disabled = true;
  btn.textContent = 'Sending...';
  fetch('/api/telegram/template/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: chatId, template: template, container: container })
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      btn.disabled = false;
      btn.textContent = 'Send';
      if (d.ok) { btn.textContent = 'Sent!'; setTimeout(function () { btn.textContent = 'Send'; }, 2000); }
      else alert(d.description || d.error || 'Failed');
    })
    .catch(function (e) { btn.disabled = false; btn.textContent = 'Send'; alert('Error: ' + e.message); });
}
