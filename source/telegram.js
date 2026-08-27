// ---------------------------------------------------------------------------
// Telegram notifications: what to send, to whom, and how often. Includes the
// per-container notification overrides that decide whether a row notifies.
// ---------------------------------------------------------------------------
const https = require('https');
const path = require('path');
const { URL } = require('url');

const { createJsonStore, DATA_DIR, appendActivityLog, resultStore } = require('./store');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

const DEFAULT_TELEGRAM_TEMPLATE = '<b>Update available!</b>\n\n' +
  'Container: <code>{container}</code>\n' +
  'Image: <code>{image}</code>\n' +
  'Registry: {registry}\n' +
  'Tag: {tag}';

const DEFAULT_UPDATE_SUCCESS_TEMPLATE = '<b>Update successful ✅</b>\n\n' +
  'Container: <code>{container}</code>\n' +
  'Image: <code>{image}</code>\n' +
  '{?remoteVersion}Version: {remoteVersion}\n{/}' +
  'Finished: {finishedAt}';

const DEFAULT_UPDATE_FAIL_TEMPLATE = '<b>Update failed ❌</b>\n\n' +
  'Container: <code>{container}</code>\n' +
  'Image: <code>{image}</code>\n' +
  'Started: {startedAt}\n' +
  'Finished: {finishedAt}\n' +
  '{?error}\nLast error: <code>{error}</code>{/}';

const TELEGRAM_CONFIG_FILE = path.join(DATA_DIR, 'telegram.json');
const TELEGRAM_SENT_FILE = path.join(DATA_DIR, 'telegram-sent.json');
const TELEGRAM_TEMPLATE_FILE = path.join(DATA_DIR, 'telegram-template.json');
const CONTAINER_NOTIFY_FILE = path.join(DATA_DIR, 'container-notify.json');

const telegramConfigStore = createJsonStore(TELEGRAM_CONFIG_FILE, () => ({ chats: [] }));
const telegramSentStore = createJsonStore(TELEGRAM_SENT_FILE, () => ({}));
const telegramTemplateStore = createJsonStore(TELEGRAM_TEMPLATE_FILE, () => ({ template: DEFAULT_TELEGRAM_TEMPLATE }));
const containerNotifyStore = createJsonStore(CONTAINER_NOTIFY_FILE, () => ({}));

// ---------------------------------------------------------------------------
// Telegram notification helpers
// ---------------------------------------------------------------------------
function loadTelegramConfig() { return telegramConfigStore.load(); }

function saveTelegramConfig(config) { telegramConfigStore.save(config); }

function loadTelegramSent() { return telegramSentStore.load(); }

function clearTelegramSentForContainer(containerName) {
  const sent = loadTelegramSent();
  let changed = false;
  for (const k of Object.keys(sent)) {
    if (k.endsWith(':' + containerName)) { delete sent[k]; changed = true; }
  }
  if (changed) saveTelegramSent(sent);
}

function saveTelegramSent(sent) { telegramSentStore.save(sent); }

async function sendTelegramMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ ok: false, description: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Telegram request timeout')); });
    req.write(body);
    req.end();
  });
}

// Three independent templates live in one file. 'outdated' keeps the original
// `template` key so existing installs keep their customised message.
const TEMPLATE_KINDS = {
  outdated: { key: 'template', default: DEFAULT_TELEGRAM_TEMPLATE },
  updateSuccess: { key: 'updateSuccess', default: DEFAULT_UPDATE_SUCCESS_TEMPLATE },
  updateFail: { key: 'updateFail', default: DEFAULT_UPDATE_FAIL_TEMPLATE }
};

function templateDefault(kind) {
  return (TEMPLATE_KINDS[kind] || TEMPLATE_KINDS.outdated).default;
}

function loadTelegramTemplate(kind = 'outdated') {
  const spec = TEMPLATE_KINDS[kind] || TEMPLATE_KINDS.outdated;
  const data = telegramTemplateStore.load();
  return data && data[spec.key] ? data[spec.key] : spec.default;
}

function saveTelegramTemplate(template, kind = 'outdated') {
  const spec = TEMPLATE_KINDS[kind] || TEMPLATE_KINDS.outdated;
  const data = { ...(telegramTemplateStore.load() || {}) };
  data[spec.key] = template;
  telegramTemplateStore.save(data);
}

function renderTelegramTemplate(template, row) {
  const tokens = {
    container: row.container, image: row.image, registry: row.registry, tag: row.tag,
    state: row.state, status: row.status,
    localDigest: row.localDigest, remoteDigest: row.remoteDigest,
    localVersion: row.localVersion, remoteVersion: row.remoteVersion,
    // Update-notification tokens; empty (and so skippable with {?…}) elsewhere.
    startedAt: row.startedAt, finishedAt: row.finishedAt, error: row.error, attempts: row.attempts
  };
  const has = (name) => {
    const v = tokens[name];
    return v !== undefined && v !== null && v !== '' && v !== '-';
  };
  // Conditional blocks: {?token}...{/}  (non-greedy, supports nesting-free usage)
  let out = template.replace(/\{\?(\w+)\}([\s\S]*?)\{\/\}/g, (_, name, inner) => has(name) ? inner : '');
  // Token substitution
  out = out.replace(/\{(\w+)\}/g, (m, name) => {
    if (tokens.hasOwnProperty(name)) return has(name) ? tokens[name] : '';
    return m;
  });
  return out.trim();
}

async function sendTelegramNotifications(results) {
  if (!TELEGRAM_BOT_TOKEN) return;
  const config = loadTelegramConfig();
  if (!config.chats || config.chats.length === 0) return;

  const runningOnly = config.runningOnly !== false;
  const cnotify = loadContainerNotify();

  let outdated = results.filter(r => r.result === 'Outdated');
  if (runningOnly) {
    outdated = outdated.filter(r => {
      if (r.state === 'running') return true;
      const co = cnotify[r.container];
      if (co && co.notifyWhenStopped) return true;
      appendActivityLog({ type: 'notify-skip', container: r.container, reason: 'not-running', detail: 'Global runningOnly is on and container has no notifyWhenStopped override' });
      return false;
    });
  }
  if (outdated.length === 0) return;

  const template = loadTelegramTemplate();
  const sent = loadTelegramSent();
  let changed = false;

  for (const chat of config.chats) {
    if (!chat.enabled) continue;
    const chatId = chat.chatId;

    for (const row of outdated) {
      const co = cnotify[row.container];
      const logBase = { container: row.container, chatId };

      if (co && co.enabled === false) {
        appendActivityLog({ type: 'notify-skip', ...logBase, reason: 'container-disabled', detail: 'Notifications disabled for this container' });
        continue;
      }
      if (co && co.chats && co.chats[chatId] && co.chats[chatId].enabled === false) {
        appendActivityLog({ type: 'notify-skip', ...logBase, reason: 'chat-disabled', detail: 'Notifications disabled for this container+chat combination' });
        continue;
      }

      // Effective mode: per-container chat override > global chat default
      let effectiveMode = chat.mode || 'once';
      if (co && co.chats && co.chats[chatId] && co.chats[chatId].mode) {
        effectiveMode = co.chats[chatId].mode;
      }

      const key = `${chatId}:${row.container}`;

      if (effectiveMode === 'once') {
        // Send once per outdated state; cleared only when container is updated via this tool
        if (sent[key]) {
          appendActivityLog({ type: 'notify-skip', ...logBase, mode: 'once', reason: 'already-sent', detail: 'Already notified; waiting for container update to reset' });
          continue;
        }
      } else {
        // 'every': resend whenever remote digest changed since last sent notification
        if (sent[key] && sent[key].remoteDigest === row.remoteDigest) {
          appendActivityLog({ type: 'notify-skip', ...logBase, mode: 'every', reason: 'digest-unchanged', detail: 'Remote digest unchanged since last notification' });
          continue;
        }
      }

      const text = renderTelegramTemplate(template, row);

      let sendOk = false;
      try {
        const result = await sendTelegramMessage(chatId, text);
        if (result.ok) {
          console.log(`[telegram] Sent notification to ${chatId} for ${row.container}`);
          appendActivityLog({ type: 'notify-sent', ...logBase, mode: effectiveMode, remoteDigest: row.remoteDigest });
          sendOk = true;
        } else {
          console.warn(`[telegram] Failed to send to ${chatId}:`, result.description);
          appendActivityLog({ type: 'notify-fail', ...logBase, reason: 'api-error', detail: result.description });
        }
      } catch (e) {
        console.warn(`[telegram] Error sending to ${chatId}:`, e.message);
        appendActivityLog({ type: 'notify-fail', ...logBase, reason: 'exception', detail: e.message });
      }

      if (sendOk) {
        sent[key] = { remoteDigest: row.remoteDigest, sentAt: new Date().toISOString() };
        changed = true;
      }
    }
  }

  if (changed) saveTelegramSent(sent);
}

// ---------------------------------------------------------------------------
// Update-result notifications
//
// Success and failure are two independent switches, each settable globally per
// chat (`notifyUpdateSuccess` / `notifyUpdateFail`) and overridable per
// container. Both default to ON, so an install that has never touched them
// still reports its update outcomes; only an explicit `false` turns one off.
// The per-container value is deliberately tri-state: absent means "inherit the
// chat default", exactly like the once/every mode.
// ---------------------------------------------------------------------------
const UPDATE_NOTIFY_KEYS = { done: 'notifyUpdateSuccess', failed: 'notifyUpdateFail' };

function updateNotifyEnabled(chat, containerOverride, status) {
  const key = UPDATE_NOTIFY_KEYS[status];
  if (!key) return false;
  const co = containerOverride;
  if (co && co.chats && co.chats[chat.chatId] && typeof co.chats[chat.chatId][key] === 'boolean') {
    return co.chats[chat.chatId][key];
  }
  return chat[key] !== false;
}

async function sendUpdateNotification(containerName, image, status, ctx = {}) {
  if (!TELEGRAM_BOT_TOKEN) return;
  if (status !== 'done' && status !== 'failed') return;
  const config = loadTelegramConfig();
  if (!config.chats || !config.chats.length) return;

  const cnotify = loadContainerNotify();
  const co = cnotify[containerName];
  if (co && co.enabled === false) return;

  // Enrich from the cache so the message can carry versions and digests too.
  let row = null;
  try {
    const cache = resultStore.load();
    row = cache && cache.results && cache.results.find(r => r.container === containerName);
  } catch { /* no cache */ }

  const data = {
    ...(row || {}),
    container: containerName, image,
    startedAt: ctx.startedAt ? new Date(ctx.startedAt).toLocaleString() : '',
    finishedAt: ctx.finishedAt ? new Date(ctx.finishedAt).toLocaleString() : '',
    error: ctx.error || ''
  };
  const template = loadTelegramTemplate(status === 'done' ? 'updateSuccess' : 'updateFail');
  const text = renderTelegramTemplate(template, data);

  for (const chat of config.chats) {
    if (!chat.enabled) continue;
    if (co && co.chats && co.chats[chat.chatId] && co.chats[chat.chatId].enabled === false) continue;
    if (!updateNotifyEnabled(chat, co, status)) continue;
    try {
      const result = await sendTelegramMessage(chat.chatId, text);
      if (result.ok) appendActivityLog({ type: 'notify-sent', container: containerName, chatId: chat.chatId, kind: 'update-' + status });
      else appendActivityLog({ type: 'notify-fail', container: containerName, chatId: chat.chatId, kind: 'update-' + status, reason: 'api-error', detail: result.description });
    } catch (e) {
      appendActivityLog({ type: 'notify-fail', container: containerName, chatId: chat.chatId, kind: 'update-' + status, reason: 'exception', detail: e.message });
    }
  }
}

// Container-level notification overrides
// { "container-name": { enabled: false, chats: { "chatId": { enabled: true, mode: "once" } } } }
function loadContainerNotify() { return containerNotifyStore.load(); }

// Compute bell icon state for a container: "default" | "disabled" | "customized"
// Takes container state into account: if global "runningOnly" is on and the
// container is not running, notifications are effectively disabled unless
// the per-container override sets notifyWhenStopped=true.
function getNotifyInfo(containerName, state) {
  const allOverrides = loadContainerNotify();
  const co = allOverrides[containerName];
  let cfg;
  try { cfg = loadTelegramConfig(); } catch { cfg = {}; }
  const runningOnly = cfg.runningOnly !== false;
  const chats = cfg.chats || [];
  const customized = !!co;

  if (co && co.enabled === false) {
    return { notifyActive: false, notifyCustomized: customized };
  }
  if (state && state !== 'running' && runningOnly && !(co && co.notifyWhenStopped)) {
    return { notifyActive: false, notifyCustomized: customized };
  }

  // Check if at least one chat would actually send to this container
  let active = false;
  for (const chat of chats) {
    if (!chat.enabled) continue;
    if (co && co.chats && co.chats[chat.chatId] && co.chats[chat.chatId].enabled === false) continue;
    active = true;
    break;
  }
  return { notifyActive: active, notifyCustomized: customized };
}

function saveContainerNotify(data) { containerNotifyStore.save(data); }

module.exports = {
  TELEGRAM_BOT_TOKEN, DEFAULT_TELEGRAM_TEMPLATE, templateDefault,
  loadTelegramConfig, saveTelegramConfig,
  loadTelegramTemplate, saveTelegramTemplate, renderTelegramTemplate,
  sendTelegramMessage, sendTelegramNotifications, sendUpdateNotification,
  clearTelegramSentForContainer,
  loadContainerNotify, saveContainerNotify, getNotifyInfo
};
