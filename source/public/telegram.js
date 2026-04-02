// =========================================================================
// Telegram Settings
// =========================================================================
var telegramConfig = { chats: [] };

function openSettingsModal() {
  fetch('/api/telegram/config')
    .then(function (r) { return r.json(); })
    .then(function (config) {
      telegramConfig = config && config.chats ? config : { chats: [] };
      telegramConfig._hasToken = config.hasToken;
      if (telegramConfig.runningOnly === undefined) telegramConfig.runningOnly = true;
      document.getElementById('tgRunningOnly').checked = telegramConfig.runningOnly !== false;
      var hasToken = config.hasToken;
      document.getElementById('telegramBotHint').style.display = hasToken ? 'none' : '';
      document.getElementById('telegramDiscoverBtn').style.display = hasToken ? '' : 'none';
      document.getElementById('telegramDesc').textContent = hasToken
        ? 'Get notified on Telegram when outdated containers are found. Add the bot to your group or start a private chat, send it a message, then hit Discover chats to find available chat IDs automatically.'
        : 'Get notified on Telegram when outdated containers are found.';
      renderTelegramChats();
      var modal = document.getElementById('settingsModal');
      modal.style.display = 'flex';
      document.body.classList.add('modal-open');
      setTimeout(function () { modal.classList.add('visible'); }, 10);
    })
    .catch(function () {
      telegramConfig = { chats: [] };
      renderTelegramChats();
      var modal = document.getElementById('settingsModal');
      modal.style.display = 'flex';
      document.body.classList.add('modal-open');
      setTimeout(function () { modal.classList.add('visible'); }, 10);
    });
}

function closeSettingsModal() {
  var modal = document.getElementById('settingsModal');
  modal.classList.remove('visible');
  setTimeout(function () {
    modal.style.display = 'none';
    document.body.classList.remove('modal-open');
  }, 300);
}

function renderTelegramChats() {
  var list = document.getElementById('telegramChatList');
  list.innerHTML = '';
  for (var i = 0; i < telegramConfig.chats.length; i++) {
    var chat = telegramConfig.chats[i];
    var div = document.createElement('div');
    div.className = 'tg-chat-item';
    div.id = 'tg-chat-' + i;
    div.style.position = 'relative';
    div.innerHTML =
      '<div class="tg-chat-row">' +
        '<label class="tg-toggle"><input type="checkbox" ' + (chat.enabled ? 'checked' : '') + ' onchange="telegramConfig.chats[' + i + '].enabled=this.checked"><span class="tg-toggle-slider"></span></label>' +
        '<input type="text" class="tg-input tg-input-name" placeholder="Name" value="' + esc(chat.name || '') + '" onchange="telegramConfig.chats[' + i + '].name=this.value">' +
        '<input type="text" class="tg-input tg-input-value" placeholder="Chat ID" value="' + esc(chat.chatId || '') + '" onchange="telegramConfig.chats[' + i + '].chatId=this.value">' +
        '<button class="tg-btn-test" onclick="testTelegramChat(' + i + ')" title="Send test message">Test</button>' +
        '<button class="tg-btn-remove" onclick="removeTelegramChat(' + i + ')" title="Remove">&times;</button>' +
      '</div>' +
      '<div class="tg-chat-mode">' +
        '<label class="tg-radio"><input type="radio" name="tg-mode-' + i + '" value="once" ' + (chat.mode !== 'every' ? 'checked' : '') + ' onchange="telegramConfig.chats[' + i + '].mode=\'once\'"> Once per mismatch</label>' +
        '<label class="tg-radio"><input type="radio" name="tg-mode-' + i + '" value="every" ' + (chat.mode === 'every' ? 'checked' : '') + ' onchange="telegramConfig.chats[' + i + '].mode=\'every\'"> Every new remote digest</label>' +
      '</div>';
    list.appendChild(div);
  }
}

function addTelegramChat() {
  telegramConfig.chats.push({ chatId: '', name: '', enabled: true, mode: 'once' });
  renderTelegramChats();
}

function showDiscoverFlash(msg, ok) {
  var el = document.getElementById('tgDiscoverFlash');
  el.textContent = msg;
  el.className = 'tg-discover-flash ' + (ok ? 'tg-flash-ok' : 'tg-flash-err') + ' visible';
  clearTimeout(el._timer);
  el._timer = setTimeout(function () { el.classList.remove('visible'); }, 4000);
}

function discoverTelegramChats() {
  var btn = document.getElementById('telegramDiscoverBtn');
  btn.disabled = true;
  btn.textContent = 'Discovering...';
  fetch('/api/telegram/discover')
    .then(function (r) { return r.json(); })
    .then(function (chats) {
      btn.disabled = false;
      btn.textContent = 'Discover chats';
      if (chats.error) { showDiscoverFlash(chats.error, false); return; }
      if (!chats.length) { showDiscoverFlash('No chats found. Send a message to the bot first, then try again.', false); return; }
      var existing = {};
      for (var i = 0; i < telegramConfig.chats.length; i++) {
        existing[telegramConfig.chats[i].chatId] = true;
      }
      var added = 0;
      for (var j = 0; j < chats.length; j++) {
        if (existing[chats[j].chatId]) continue;
        telegramConfig.chats.push({
          chatId: chats[j].chatId,
          name: chats[j].name || '',
          enabled: true,
          mode: 'once'
        });
        added++;
      }
      renderTelegramChats();
      if (added === 0) showDiscoverFlash('All discovered chats are already added.', true);
      else showDiscoverFlash('Found ' + added + ' new chat(s).', true);
    })
    .catch(function (e) {
      btn.disabled = false;
      btn.textContent = 'Discover chats';
      showDiscoverFlash('Error: ' + e.message, false);
    });
}

function removeTelegramChat(idx) {
  var chat = telegramConfig.chats[idx];
  var label = chat && (chat.name || chat.chatId) ? esc(chat.name || chat.chatId) : '#' + (idx + 1);
  showConfirmModal(
    'Remove chat <strong>' + label + '</strong> from notifications?',
    function () {
      telegramConfig.chats.splice(idx, 1);
      renderTelegramChats();
    },
    { title: 'Remove Chat?', icon: '🗑️', confirmText: 'Remove' }
  );
}

function showChatFlash(idx, success, msg) {
  var item = document.getElementById('tg-chat-' + idx);
  if (!item) return;
  var flash = document.createElement('div');
  flash.className = 'tg-flash ' + (success ? 'tg-flash-ok' : 'tg-flash-err');
  flash.textContent = msg;
  item.appendChild(flash);
  requestAnimationFrame(function () { flash.classList.add('visible'); });
  setTimeout(function () {
    flash.classList.remove('visible');
    setTimeout(function () { if (flash.parentNode) flash.parentNode.removeChild(flash); }, 300);
  }, 2000);
}

function testTelegramChat(idx) {
  var chat = telegramConfig.chats[idx];
  if (!chat || !chat.chatId) { showChatFlash(idx, false, 'Enter a Chat ID first'); return; }
  fetch('/api/telegram/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: chat.chatId })
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.ok) showChatFlash(idx, true, 'Sent!');
      else showChatFlash(idx, false, d.description || d.error || 'Failed');
    })
    .catch(function (e) { showChatFlash(idx, false, e.message); });
}

// =========================================================================
// Per-container notification overrides (modal-based)
// =========================================================================
var cnotifyCache = {};
var cnotifyChatsCache = {};
var cnotifyCurrentIdx = null;
var cnotifyCurrentContainer = null;

function openContainerNotifyModal(container, idx) {
  cnotifyCurrentIdx = idx;
  cnotifyCurrentContainer = container;
  document.getElementById('cnotifyModalTitle').textContent = container;
  document.getElementById('cnotifyModalContent').innerHTML = '<div class="cnotify-empty">Loading...</div>';
  var modal = document.getElementById('cnotifyModal');
  modal.style.display = 'flex';
  document.body.classList.add('modal-open');
  setTimeout(function () { modal.classList.add('visible'); }, 10);

  Promise.all([
    fetch('/api/telegram/config').then(function (r) { return r.json(); }),
    fetch('/api/container-notify/' + encodeURIComponent(container)).then(function (r) { return r.json(); })
  ]).then(function (results) {
    var tgConfig = results[0];
    var hasOverride = !!results[1];
    var co = results[1] || { enabled: true, chats: {} };
    if (!co.chats) co.chats = {};
    cnotifyCache[container] = co;
    cnotifyChatsCache[container] = tgConfig.chats || [];
    renderContainerNotify(container, cnotifyChatsCache[container], co);
    updateCnotifyBtnState(idx, container);
    document.getElementById('cnotifyResetBtn').style.display = hasOverride ? '' : 'none';
  });
}

function closeCnotifyModal() {
  var modal = document.getElementById('cnotifyModal');
  modal.classList.remove('visible');
  setTimeout(function () {
    modal.style.display = 'none';
    document.body.classList.remove('modal-open');
  }, 300);
  cnotifyCurrentIdx = null;
  cnotifyCurrentContainer = null;
}

function renderContainerNotify(container, chats, co) {
  var panel = document.getElementById('cnotifyModalContent');
  if (!chats || chats.length === 0) {
    panel.innerHTML = '<div class="cnotify-empty">No Telegram chats configured. Add them in the global settings.</div>';
    return;
  }
  var masterChecked = co.enabled !== false;
  var html =
    '<div class="cnotify-row cnotify-master">' +
      '<label class="tg-toggle"><input type="checkbox" ' + (masterChecked ? 'checked' : '') + ' onchange="cnotifySetEnabled(this.checked)"><span class="tg-toggle-slider"></span></label>' +
      '<span class="cnotify-label">Enable notifications for this container</span>' +
    '</div>' +
    '<div class="cnotify-chats" id="cnotify-chats-modal" style="' + (masterChecked ? '' : 'display:none') + '">';

  for (var i = 0; i < chats.length; i++) {
    var chat = chats[i];
    var chatOverride = co.chats[chat.chatId] || {};
    var chatEnabled = chatOverride.enabled !== false;
    var chatMode = chatOverride.mode || chat.mode || 'once';
    var label = chat.name ? esc(chat.name) : esc(chat.chatId);

    html +=
      '<div class="cnotify-row cnotify-chat-row">' +
        '<label class="tg-toggle"><input type="checkbox" ' + (chatEnabled ? 'checked' : '') + ' onchange="cnotifySetChatEnabled(\'' + esc(chat.chatId) + '\', this.checked)"><span class="tg-toggle-slider"></span></label>' +
        '<span class="cnotify-label">' + label + '</span>' +
        '<div class="cnotify-mode">' +
          '<label class="tg-radio"><input type="radio" name="cnotify-mode-m-' + i + '" value="once" ' + (chatMode !== 'every' ? 'checked' : '') + ' onchange="cnotifySetChatMode(\'' + esc(chat.chatId) + '\', \'once\')"> Once</label>' +
          '<label class="tg-radio"><input type="radio" name="cnotify-mode-m-' + i + '" value="every" ' + (chatMode === 'every' ? 'checked' : '') + ' onchange="cnotifySetChatMode(\'' + esc(chat.chatId) + '\', \'every\')"> Every</label>' +
        '</div>' +
      '</div>';
  }
  html += '</div>';
  panel.innerHTML = html;
}

function updateCnotifyBtnState(idx, container) {
  var icon = document.getElementById('cnotify-icon-' + idx);
  var btn = document.getElementById('cnotify-btn-' + idx);
  if (!icon) return;
  var co = cnotifyCache[container];
  icon.className = 'cnotify-icon';
  if (btn) btn.classList.remove('cnotify-state-disabled');

  if (!co) return;

  if (co.enabled === false) {
    icon.classList.add('cnotify-disabled');
    if (btn) btn.classList.add('cnotify-state-disabled');
    return;
  }

  var chats = cnotifyChatsCache[container] || [];
  var customized = false;
  for (var i = 0; i < chats.length; i++) {
    var chatId = chats[i].chatId;
    var ov = co.chats && co.chats[chatId];
    if (!ov) continue;
    if (ov.enabled === false) { customized = true; break; }
    if (ov.mode && ov.mode !== (chats[i].mode || 'once')) { customized = true; break; }
  }
  if (customized) icon.classList.add('cnotify-customized');
}

function loadAllCnotifyStates() {
  // Refresh bell icons from APP.results notifyState after table rebuild
  for (var i = 0; i < APP.results.length; i++) {
    var row = APP.results[i];
    var idx = i + 1;
    if (row.notifyState === 'disabled') {
      var ni = document.getElementById('cnotify-icon-' + idx);
      var nb = document.getElementById('cnotify-btn-' + idx);
      if (ni) ni.classList.add('cnotify-disabled');
      if (nb) nb.classList.add('cnotify-state-disabled');
    } else if (row.notifyState === 'customized') {
      var ni2 = document.getElementById('cnotify-icon-' + idx);
      if (ni2) ni2.classList.add('cnotify-customized');
    }
  }
}

function cnotifySave() {
  var container = cnotifyCurrentContainer;
  var co = cnotifyCache[container];
  if (!co || !container) return;
  fetch('/api/container-notify/' + encodeURIComponent(container), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(co)
  });
  var resetBtn = document.getElementById('cnotifyResetBtn');
  if (resetBtn) resetBtn.style.display = '';
}

function cnotifySetEnabled(val) {
  var container = cnotifyCurrentContainer;
  var idx = cnotifyCurrentIdx;
  cnotifyCache[container].enabled = val;
  var row = APP.results.find(function (r, i) { return (i + 1) == idx; });
  if (row) row.notifyState = val ? 'customized' : 'disabled';
  var chatsEl = document.getElementById('cnotify-chats-modal');
  if (chatsEl) chatsEl.style.display = val ? '' : 'none';
  updateCnotifyBtnState(idx, container);
  cnotifySave();
}

function cnotifySetChatEnabled(chatId, val) {
  var container = cnotifyCurrentContainer;
  var idx = cnotifyCurrentIdx;
  var co = cnotifyCache[container];
  if (!co.chats[chatId]) co.chats[chatId] = {};
  co.chats[chatId].enabled = val;
  updateCnotifyBtnState(idx, container);
  cnotifySave();
}

function cnotifySetChatMode(chatId, mode) {
  var container = cnotifyCurrentContainer;
  var idx = cnotifyCurrentIdx;
  var co = cnotifyCache[container];
  if (!co.chats[chatId]) co.chats[chatId] = {};
  co.chats[chatId].mode = mode;
  updateCnotifyBtnState(idx, container);
  cnotifySave();
}

function cnotifyResetToDefault() {
  var container = cnotifyCurrentContainer;
  var idx = cnotifyCurrentIdx;
  if (!container) return;
  fetch('/api/container-notify/' + encodeURIComponent(container), { method: 'DELETE' })
    .then(function (r) { return r.json(); })
    .then(function () {
      delete cnotifyCache[container];
      var row = APP.results.find(function (r, i) { return (i + 1) == idx; });
      if (row) row.notifyState = 'default';
      if (idx !== null) updateCnotifyBtnState(idx, container);
      closeCnotifyModal();
    });
}

function saveTelegramSettings() {
  telegramConfig.chats = telegramConfig.chats.filter(function (c) { return c.chatId && c.chatId.trim(); });
  fetch('/api/telegram/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(telegramConfig)
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.ok) closeSettingsModal();
      else alert('Failed to save: ' + JSON.stringify(d));
    })
    .catch(function (e) { alert('Error: ' + e.message); });
}
