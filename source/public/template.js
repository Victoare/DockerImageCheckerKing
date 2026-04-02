// =========================================================================
// Template Editor
// =========================================================================
var tmplDefault = '';
var tmplOriginal = '';

function openTemplateEditor() {
  fetch('/api/telegram/template')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      tmplDefault = data.default || '';
      tmplOriginal = data.template || tmplDefault;
      document.getElementById('tmplEditor').value = tmplOriginal;
      tmplPopulateContainerSelect();
      tmplPopulateChatSelect();
      tmplUpdatePreview();
      var modal = document.getElementById('templateModal');
      modal.style.display = 'flex';
      document.body.classList.add('modal-open');
      setTimeout(function () { modal.classList.add('visible'); }, 10);
    });
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
  localDigest: 'sha256:abc123...', remoteDigest: 'sha256:def456...'
};

function tmplRenderPreview(template, data) {
  return template
    .replace(/\{container\}/g, data.container || '')
    .replace(/\{image\}/g, data.image || '')
    .replace(/\{registry\}/g, data.registry || '')
    .replace(/\{tag\}/g, data.tag || '')
    .replace(/\{state\}/g, data.state || '')
    .replace(/\{status\}/g, data.status || '')
    .replace(/\{localDigest\}/g, data.localDigest || '')
    .replace(/\{remoteDigest\}/g, data.remoteDigest || '');
}

function tmplUpdatePreview() {
  var template = document.getElementById('tmplEditor').value;
  var sel = document.getElementById('tmplPreviewSelect').value;
  var data = TMPL_MOCK;
  if (sel !== '__mock__') {
    var row = APP.results.find(function (r) { return r.container === sel; });
    if (row) data = row;
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
  document.getElementById('tmplEditor').value = tmplDefault;
  tmplUpdatePreview();
}

function saveTemplate() {
  var template = document.getElementById('tmplEditor').value;
  fetch('/api/telegram/template', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template: template })
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.ok) closeTemplateEditor();
      else alert('Failed to save: ' + JSON.stringify(d));
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
