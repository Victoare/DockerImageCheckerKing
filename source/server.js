const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// ---------------------------------------------------------------------------
// TTL file cache — keeps parsed JSON in memory for `ttl` ms after last access
// ---------------------------------------------------------------------------
function createFileCache(filePath, fallback, ttl = 300000) {
  let data = null, timer = null;
  function touch() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { data = null; timer = null; }, ttl);
  }
  return {
    load() {
      if (data !== null) { touch(); return data; }
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { data = fallback(); }
      touch();
      return data;
    },
    invalidate() { data = null; if (timer) { clearTimeout(timer); timer = null; } }
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const HTTPS_TIMEOUT = 15000;
const DOCKER_TIMEOUT = 30000;
const USER_AGENT = 'docker-image-checker/1.0';
const ACCEPT_HEADER = [
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json'
].join(', ');
const DOCKER_HUB_ALIASES = ['docker.io', 'index.docker.io', 'registry-1.docker.io', 'registry.hub.docker.com'];

const app = express();
const PORT = process.env.PORT || 8080;
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const DATA_DIR = process.env.DATA_DIR || '/data';
const CACHE_FILE = path.join(DATA_DIR, 'last-result.json');
const UPDATE_LOGS_FILE = path.join(DATA_DIR, 'update-logs.json');
const TELEGRAM_CONFIG_FILE = path.join(DATA_DIR, 'telegram.json');
const TELEGRAM_SENT_FILE = path.join(DATA_DIR, 'telegram-sent.json');

const CONTAINER_NOTIFY_FILE = path.join(DATA_DIR, 'container-notify.json');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

// Ensure data directory exists
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.warn('[init] Could not create data dir:', e.message); }

app.use(express.json());

// ---------------------------------------------------------------------------
// In-memory state for active updates
// { [containerName]: { image, status: 'running'|'done'|'failed', log: [{time,msg,type}], clients: [res] } }
// ---------------------------------------------------------------------------
const activeUpdates = {};

// ---------------------------------------------------------------------------
// Registry rate-limit tracking
// ---------------------------------------------------------------------------
const RATE_LIMIT_FILE = path.join(DATA_DIR, 'rate-limits.json');
let rateLimits = {};
try { rateLimits = JSON.parse(fs.readFileSync(RATE_LIMIT_FILE, 'utf8')); } catch { /* no file yet */ }

function updateRateLimit(registry, responseHeaders) {
  const limit = responseHeaders['ratelimit-limit'] || responseHeaders['x-ratelimit-limit'];
  const remaining = responseHeaders['ratelimit-remaining'] || responseHeaders['x-ratelimit-remaining'];
  const rlHeaders = {};
  for (const key of Object.keys(responseHeaders)) {
    if (key.includes('ratelimit') || key.includes('rate-limit') || key.includes('retry')) {
      rlHeaders[key] = responseHeaders[key];
    }
  }
  if (Object.keys(rlHeaders).length > 0) {
    console.log(`[rate-limit] ${registry}:`, rlHeaders);
  }
  if (!limit && !remaining) return;
  const parse = (val) => { if (!val) return null; const m = val.match(/^(\d+)/); return m ? parseInt(m[1], 10) : null; };
  rateLimits[registry] = {
    limit: parse(limit),
    remaining: parse(remaining),
    updatedAt: new Date().toISOString()
  };
  try { fs.writeFileSync(RATE_LIMIT_FILE, JSON.stringify(rateLimits, null, 2)); } catch (e) { console.warn('[rate-limit] Failed to save:', e.message); }
}

// ---------------------------------------------------------------------------
// Persistent update logs helpers (one entry per container)
// ---------------------------------------------------------------------------
function loadUpdateLogs() {
  try {
    return JSON.parse(fs.readFileSync(UPDATE_LOGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveUpdateLog(container, entry) {
  const logs = loadUpdateLogs();
  logs[container] = entry;
  try {
    fs.writeFileSync(UPDATE_LOGS_FILE, JSON.stringify(logs, null, 2));
  } catch (e) {
    console.error('[update-log] Failed to save:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Unified Docker socket helper
// ---------------------------------------------------------------------------
function dockerApi(method, apiPath, { body, stream } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    let data = null;

    if (body !== undefined) {
      data = JSON.stringify(body);
      headers['Content-Length'] = Buffer.byteLength(data);
    } else if (method === 'POST') {
      headers['Content-Length'] = 0;
    }

    const options = {
      socketPath: DOCKER_SOCKET,
      path: apiPath,
      method,
      headers
    };

    const req = http.request(options, (res) => {
      // Streaming mode (for image pull)
      if (stream) {
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
              try { stream(JSON.parse(trimmed)); } catch { stream({ status: trimmed }); }
            }
          }
        });
        res.on('end', () => {
          if (buffer.trim()) {
            try { stream(JSON.parse(buffer.trim())); } catch { stream({ status: buffer.trim() }); }
          }
          resolve(res.statusCode);
        });
        return;
      }

      // Normal mode — collect body
      let rawBody = '';
      res.on('data', (chunk) => (rawBody += chunk));
      res.on('end', () => {
        if (method === 'DELETE') {
          resolve(res.statusCode);
          return;
        }
        // POST without body or with body — return statusCode + parsed body
        if (method === 'POST') {
          let parsed = null;
          try { parsed = JSON.parse(rawBody); } catch { /* not JSON */ }
          resolve({ statusCode: res.statusCode, body: parsed || rawBody });
          return;
        }
        // GET — return parsed JSON
        try {
          resolve(JSON.parse(rawBody));
        } catch (e) {
          reject(new Error(`Failed to parse Docker response for ${apiPath}: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(DOCKER_TIMEOUT, () => { req.destroy(); reject(new Error(`Docker request timeout: ${method} ${apiPath}`)); });

    if (data) req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// HTTPS fetch helpers
// ---------------------------------------------------------------------------
function httpsRequest(method, url, headers = {}, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method,
      headers: { 'User-Agent': USER_AGENT, ...headers }
    };
    const req = https.request(options, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        return httpsRequest(method, res.headers.location, headers, maxRedirects - 1).then(resolve).catch(reject);
      }
      if (method === 'HEAD') {
        res.resume();
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers }));
        return;
      }
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(HTTPS_TIMEOUT, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

function httpsGet(url, headers = {}, maxRedirects = 5) {
  return httpsRequest('GET', url, headers, maxRedirects);
}

function httpsHead(url, headers = {}, maxRedirects = 5) {
  return httpsRequest('HEAD', url, headers, maxRedirects);
}

// ---------------------------------------------------------------------------
// Image & Token Helpers
// ---------------------------------------------------------------------------
function parseImageReference(image) {
  if (image.includes('@sha256:')) return null;
  let tag = 'latest', registry = 'docker.io', repo = image;
  const tagMatch = repo.match(/:([^:/]+)$/);
  if (tagMatch) { tag = tagMatch[1]; repo = repo.replace(/:[^:/]+$/, ''); }
  const parts = repo.split('/', 2);
  if (parts.length === 2 && (parts[0].includes('.') || parts[0].includes(':'))) {
    registry = parts[0]; repo = repo.substring(registry.length + 1);
  } else if (!repo.includes('/')) { repo = `library/${repo}`; }
  if (DOCKER_HUB_ALIASES.includes(registry)) registry = 'docker.io';
  return { registry, repo, tag, cacheKey: `${registry}/${repo}:${tag}` };
}

async function getTokenFromChallenge(registry, repo, wwwAuth) {
  const realmMatch = wwwAuth.match(/Bearer\s+realm="([^"]+)"/i);
  if (!realmMatch) return null;
  const realm = realmMatch[1];
  const serviceMatch = wwwAuth.match(/service="([^"]+)"/);
  const service = serviceMatch ? serviceMatch[1] : '';
  const url = `${realm}?service=${service}&scope=repository:${repo}:pull`;
  try {
    const res = await httpsGet(url);
    if (res.statusCode === 200) {
      const data = JSON.parse(res.body);
      return data.token || data.access_token || null;
    }
  } catch (e) { console.warn(`[auth] Challenge token fetch failed for ${registry}:`, e.message); }
  return null;
}

// ---------------------------------------------------------------------------
// Registry handlers — each returns { manifestUrl, headers }
// ---------------------------------------------------------------------------
const registryHandlers = {
  'docker.io': {
    async authenticate(repo) {
      const res = await httpsGet(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`);
      return res.statusCode === 200 ? JSON.parse(res.body).token : null;
    },
    getManifestUrl(repo, tag) {
      return `https://registry-1.docker.io/v2/${repo}/manifests/${tag}`;
    }
  },

  'ghcr.io': {
    async authenticate(repo) {
      const res = await httpsGet(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repo}:pull`);
      return res.statusCode === 200 ? JSON.parse(res.body).token : null;
    },
    getManifestUrl(repo, tag) {
      return `https://ghcr.io/v2/${repo}/manifests/${tag}`;
    }
  },

  'gcr': {
    match: (registry) => /^(gcr\.io|.*\.gcr\.io|.*-docker\.pkg\.dev)$/.test(registry),
    async authenticate(repo, registry) {
      try {
        const tokenUrl = `https://${registry}/v2/token?service=${registry}&scope=repository:${repo}:pull`;
        const tres = await httpsGet(tokenUrl);
        return tres.statusCode === 200 ? JSON.parse(tres.body).token : null;
      } catch { return null; }
    },
    getManifestUrl(repo, tag, registry) {
      return `https://${registry}/v2/${repo}/manifests/${tag}`;
    }
  },

  'quay.io': {
    async authenticate(repo, registry, manifestUrl) {
      try {
        const test = await httpsHead(manifestUrl, { 'Accept': ACCEPT_HEADER });
        if (test.statusCode === 401 && test.headers['www-authenticate']) {
          return await getTokenFromChallenge(registry, repo, test.headers['www-authenticate']);
        }
      } catch { /* continue without auth */ }
      return null;
    },
    getManifestUrl(repo, tag) {
      return `https://quay.io/v2/${repo}/manifests/${tag}`;
    }
  },

  'public.ecr.aws': {
    async authenticate(repo) {
      try {
        const tres = await httpsGet(`https://public.ecr.aws/token/?service=public.ecr.aws&scope=repository:${repo}:pull`);
        return tres.statusCode === 200 ? JSON.parse(tres.body).token : null;
      } catch { return null; }
    },
    getManifestUrl(repo, tag) {
      return `https://public.ecr.aws/v2/${repo}/manifests/${tag}`;
    }
  }
};

function getRegistryHandler(registry) {
  if (registryHandlers[registry]) return registryHandlers[registry];
  // Check pattern-based handlers (e.g. GCR variants)
  for (const handler of Object.values(registryHandlers)) {
    if (handler.match && handler.match(registry)) return handler;
  }
  return null; // generic/unknown
}

async function getRemoteDigest(registry, repo, tag) {
  const handler = getRegistryHandler(registry);
  let manifestUrl, headers = { 'Accept': ACCEPT_HEADER };

  if (handler) {
    manifestUrl = handler.getManifestUrl(repo, tag, registry);
    const token = await handler.authenticate(repo, registry, manifestUrl);
    if (token) headers['Authorization'] = `Bearer ${token}`;
    else if (registry === 'docker.io' || registry === 'ghcr.io') return null; // these require auth
  } else {
    // Generic/unknown registry — try with challenge-based auth
    manifestUrl = `https://${registry}/v2/${repo}/manifests/${tag}`;
    try {
      const test = await httpsHead(manifestUrl, headers);
      if (test.statusCode === 401 && test.headers['www-authenticate']) {
        const token = await getTokenFromChallenge(registry, repo, test.headers['www-authenticate']);
        if (token) headers['Authorization'] = `Bearer ${token}`;
        else return null;
      }
    } catch (e) { console.warn(`[digest] Generic registry probe failed for ${registry}:`, e.message); return null; }
  }

  // Try HEAD first (faster, no body)
  try {
    const res = await httpsHead(manifestUrl, headers);
    updateRateLimit(registry, res.headers);
    if (res.statusCode === 200 && res.headers['docker-content-digest']) return res.headers['docker-content-digest'].trim();
  } catch (e) { console.warn(`[digest] HEAD failed for ${registry}/${repo}:${tag}:`, e.message); }

  // Fallback to GET + compute hash
  try {
    const res = await httpsGet(manifestUrl, headers);
    updateRateLimit(registry, res.headers);
    if (res.statusCode === 200) {
      if (res.headers['docker-content-digest']) return res.headers['docker-content-digest'].trim();
      const hash = crypto.createHash('sha256').update(res.body).digest('hex');
      return `sha256:${hash}`;
    }
  } catch (e) { console.warn(`[digest] GET failed for ${registry}/${repo}:${tag}:`, e.message); }

  return null;
}

// ---------------------------------------------------------------------------
// Shared check logic (used by both SSE endpoint and auto-check)
// ---------------------------------------------------------------------------
async function runCheck(includeStopped, onProgress, onResult) {
  const containerList = await dockerApi('GET', `/containers/json?all=${includeStopped}`);
  const digestCache = {};
  const results = [];
  for (let i = 0; i < containerList.length; i++) {
    const ctr = containerList[i];
    const name = (ctr.Names && ctr.Names[0]) ? ctr.Names[0].replace(/^\//, '') : ctr.Id.substring(0, 12);
    const image = ctr.Image;
    if (onProgress) onProgress({ index: i, total: containerList.length, container: name, image });
    const parsed = parseImageReference(image);
    if (!parsed) {
      const row = { container: name, image, state: ctr.State, status: ctr.Status, registry: '-', tag: '-', result: 'Pinned', localDigest: '-', remoteDigest: '-', notifyState: getNotifyState(name) };
      results.push(row); if (onResult) onResult(row); continue;
    }
    let localDigest = null;
    try {
      const inspect = await dockerApi('GET', `/images/${encodeURIComponent(image)}/json`);
      if (inspect.RepoDigests && inspect.RepoDigests.length > 0) {
        for (const d of inspect.RepoDigests) {
          const m = d.match(/@(sha256:[a-f0-9]+)/);
          if (m) { localDigest = m[1]; break; }
        }
      }
    } catch (e) {
      try {
        const inspect = await dockerApi('GET', `/images/${ctr.ImageID}/json`);
        if (inspect.RepoDigests && inspect.RepoDigests.length > 0) {
          for (const d of inspect.RepoDigests) {
            const m = d.match(/@(sha256:[a-f0-9]+)/);
            if (m) { localDigest = m[1]; break; }
          }
        }
      } catch (e2) { console.warn(`[check] Could not inspect image for ${name}:`, e2.message); }
    }
    let remoteDigest = null, fromCache = false;
    if (digestCache.hasOwnProperty(parsed.cacheKey)) {
      remoteDigest = digestCache[parsed.cacheKey]; fromCache = true;
    } else {
      remoteDigest = await getRemoteDigest(parsed.registry, parsed.repo, parsed.tag);
      if (remoteDigest === null && parsed.registry !== 'docker.io') remoteDigest = await getRemoteDigest('docker.io', parsed.repo, parsed.tag);
      digestCache[parsed.cacheKey] = remoteDigest;
    }
    let result = 'Unknown';
    if (remoteDigest === null) result = 'Unknown';
    else if (localDigest === null) result = 'NoLocalDigest';
    else if (localDigest === remoteDigest) result = 'UpToDate';
    else result = 'Outdated';
    const row = { container: name, image, state: ctr.State, status: ctr.Status, registry: parsed.registry, tag: parsed.tag, result, localDigest: localDigest || '-', remoteDigest: remoteDigest || '-', cached: fromCache, notifyState: getNotifyState(name) };
    results.push(row); if (onResult) onResult(row);
  }
  const timestamp = new Date().toISOString();
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ timestamp, results }, null, 2)); } catch (e) { console.warn('[check] Failed to save cache:', e.message); }
  return { timestamp, results };
}

app.get('/api/check', async (req, res) => {
  const includeStopped = req.query.includeStopped === 'true';
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    const containerList = await dockerApi('GET', `/containers/json?all=${includeStopped}`);
    send('total', { count: containerList.length });
    const result = await runCheck(includeStopped,
      (p) => send('progress', p),
      (r) => send('result', r)
    );
    scheduleNextAutoCheck();
    send('done', { total: result.results.length });
    sendTelegramNotifications(result.results).catch(e => console.warn('[telegram] Notification error:', e.message));
  } catch (err) { send('error', { message: err.message }); }
  res.end();
});

// ---------------------------------------------------------------------------
// Telegram notification helpers
// ---------------------------------------------------------------------------
const telegramConfigCache = createFileCache(TELEGRAM_CONFIG_FILE, () => ({ chats: [] }));
function loadTelegramConfig() { return telegramConfigCache.load(); }
function saveTelegramConfig(config) {
  try { fs.writeFileSync(TELEGRAM_CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (e) { console.warn('[telegram] Failed to save config:', e.message); }
  telegramConfigCache.invalidate();
}

function loadTelegramSent() {
  try { return JSON.parse(fs.readFileSync(TELEGRAM_SENT_FILE, 'utf8')); } catch { return {}; }
}

function saveTelegramSent(sent) {
  try { fs.writeFileSync(TELEGRAM_SENT_FILE, JSON.stringify(sent, null, 2)); } catch (e) { console.warn('[telegram] Failed to save sent state:', e.message); }
}

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

async function sendTelegramNotifications(results) {
  if (!TELEGRAM_BOT_TOKEN) return;
  const config = loadTelegramConfig();
  if (!config.chats || config.chats.length === 0) return;

  const outdated = results.filter(r => r.result === 'Outdated');
  if (outdated.length === 0) return;

  const sent = loadTelegramSent();
  const cnotify = loadContainerNotify();
  let changed = false;

  for (const chat of config.chats) {
    if (!chat.enabled) continue;
    const chatId = chat.chatId;

    for (const row of outdated) {
      // Per-container override check
      const co = cnotify[row.container];
      if (co) {
        if (co.enabled === false) continue; // all notifications disabled for this container
        if (co.chats && co.chats[chatId]) {
          if (co.chats[chatId].enabled === false) continue; // this chat disabled for this container
        }
      }

      // Determine effective mode: per-container chat override > global chat default
      let effectiveMode = chat.mode || 'once';
      if (co && co.chats && co.chats[chatId] && co.chats[chatId].mode) {
        effectiveMode = co.chats[chatId].mode;
      }

      const key = `${chatId}:${row.container}`;
      const digestKey = `${row.localDigest}|${row.remoteDigest}`;

      if (effectiveMode === 'once') {
        if (sent[key] && sent[key].digestKey === digestKey) continue;
      } else {
        if (sent[key] && sent[key].remoteDigest === row.remoteDigest) continue;
      }

      const text =
        `<b>Update available!</b>\n\n` +
        `Container: <code>${row.container}</code>\n` +
        `Image: <code>${row.image}</code>\n` +
        `Registry: ${row.registry}\n` +
        `Tag: ${row.tag}`;

      try {
        const result = await sendTelegramMessage(chatId, text);
        if (result.ok) {
          console.log(`[telegram] Sent notification to ${chatId} for ${row.container}`);
        } else {
          console.warn(`[telegram] Failed to send to ${chatId}:`, result.description);
        }
      } catch (e) {
        console.warn(`[telegram] Error sending to ${chatId}:`, e.message);
      }

      sent[key] = { digestKey, remoteDigest: row.remoteDigest, sentAt: new Date().toISOString() };
      changed = true;
    }
  }

  if (changed) saveTelegramSent(sent);
}

// Container-level notification overrides
// { "container-name": { enabled: false, chats: { "chatId": { enabled: true, mode: "once" } } } }
const containerNotifyCache = createFileCache(CONTAINER_NOTIFY_FILE, () => ({}));
function loadContainerNotify() { return containerNotifyCache.load(); }

// Compute bell icon state for a container: "default" | "disabled" | "customized"
function getNotifyState(containerName) {
  const allOverrides = loadContainerNotify();
  const co = allOverrides[containerName];
  if (!co) return 'default';
  if (co.enabled === false) return 'disabled';
  return 'customized';
}

function saveContainerNotify(data) {
  try { fs.writeFileSync(CONTAINER_NOTIFY_FILE, JSON.stringify(data, null, 2)); } catch (e) { console.warn('[notify] Failed to save:', e.message); }
  containerNotifyCache.invalidate();
}

// Telegram API endpoints
app.get('/api/telegram/config', (_req, res) => {
  const config = loadTelegramConfig();
  config.hasToken = !!TELEGRAM_BOT_TOKEN;
  res.json(config);
});

app.post('/api/telegram/config', (req, res) => {
  const config = req.body;
  if (!config || !Array.isArray(config.chats)) return res.status(400).json({ error: 'Invalid config' });
  saveTelegramConfig(config);
  res.json({ ok: true });
});

app.post('/api/telegram/test', async (req, res) => {
  const { chatId } = req.body;
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  if (!TELEGRAM_BOT_TOKEN) return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not configured' });
  try {
    const result = await sendTelegramMessage(chatId,
      '<b>Update available!</b>\n\n' +
      'Container: <code>my-awesome-app</code>\n' +
      'Image: <code>nginx:latest</code>\n' +
      'Registry: docker.io\n' +
      'Tag: latest\n\n' +
      '<i>This is a test notification.</i>');
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
// Auto-check scheduler
// ---------------------------------------------------------------------------
const AUTO_CHECK_FAST_MINUTES = parseInt(process.env.AUTO_CHECK_FAST_MINUTES, 10) || 60;
const AUTO_CHECK_SLOW_MINUTES = parseInt(process.env.AUTO_CHECK_MINUTES, 10) || 360;
const AUTO_CHECK_FAST = AUTO_CHECK_FAST_MINUTES * 60 * 1000;
const AUTO_CHECK_SLOW = AUTO_CHECK_SLOW_MINUTES * 60 * 1000;
let nextAutoCheckTime = null;
let autoCheckTimer = null;

function getAutoCheckInterval() {
  const dh = rateLimits['docker.io'];
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
    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
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
    try {
      const autoResult = await runCheck(true, null, null);
      console.log('Auto-check complete.');
      sendTelegramNotifications(autoResult.results).catch(e => console.warn('[telegram] Notification error:', e.message));
    } catch (e) {
      console.error('Auto-check failed:', e.message);
    }
    scheduleNextAutoCheck();
  }, delay);
}

app.get('/api/next-check', (_req, res) => {
  res.json({ nextAutoCheck: nextAutoCheckTime, intervalMs: getAutoCheckInterval(), fastMinutes: AUTO_CHECK_FAST_MINUTES, slowMinutes: AUTO_CHECK_SLOW_MINUTES });
});

app.get('/api/rate-limits', (_req, res) => {
  res.json(rateLimits);
});

app.get('/api/last-result', (_req, res) => {
  try {
    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (cache && cache.results) {
      for (const row of cache.results) row.notifyState = getNotifyState(row.container);
    }
    res.json(cache);
  } catch { res.json(null); }
});

app.get('/api/version', (_req, res) => res.json({ version: process.env.BUILD_VERSION || 'dev' }));

app.get('/api/update-logs', (_req, res) => res.json(loadUpdateLogs()));

app.get('/api/update-status', (_req, res) => {
  const status = {};
  for (const [name, state] of Object.entries(activeUpdates)) status[name] = { status: state.status, image: state.image };
  res.json(status);
});

function broadcastLog(container, line) {
  const state = activeUpdates[container];
  if (!state) return;
  state.log.push(line);
  const payload = `event: log\ndata: ${JSON.stringify(line)}\n\n`;
  for (const client of state.clients) try { client.write(payload); } catch { /* disconnected */ }
}

function broadcastStatus(container, status) {
  const state = activeUpdates[container];
  if (!state) return;
  const payload = `event: status\ndata: ${JSON.stringify({ status })}\n\n`;
  for (const client of state.clients) try { client.write(payload); client.end(); } catch { /* skip */ }
  state.clients = [];
}

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

// ---------------------------------------------------------------------------
// CORE: "Clone & Swap" Update Logic (Watchtower style)
// ---------------------------------------------------------------------------
async function runUpdate(containerName, image) {
  const log = (msg, type = 'info') => broadcastLog(containerName, { time: new Date().toISOString(), msg, type });

  try {
    // 1. PULL IMAGE
    const parsed = parseImageReference(image);
    if (!parsed) {
      log(`Image pinned by digest (${image}), skipped pull.`, 'warn');
    } else {
      let fromImage = (parsed.registry === 'docker.io') ? (parsed.repo.startsWith('library/') ? parsed.repo.substring(8) : parsed.repo) : `${parsed.registry}/${parsed.repo}`;
      log(`Pulling ${fromImage}:${parsed.tag} …`, 'info');
      let failed = false;
      const pullCode = await dockerApi('POST', `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(parsed.tag)}`, {
        stream: (chunk) => {
          if (chunk.error) { log(`Pull error: ${chunk.error}`, 'error'); failed = true; }
          else if (chunk.status) log(chunk.id ? `[${chunk.id}] ${chunk.status}` : chunk.status, 'info');
        }
      });
      if (failed || pullCode !== 200) { log('Pull failed.', 'error'); finishUpdate(containerName, 'failed'); return; }
      log('Pull complete.', 'ok');
    }

    // 2. INSPECT OLD CONTAINER
    log(`Inspecting "${containerName}" …`, 'info');
    const oldInfo = await dockerApi('GET', `/containers/${encodeURIComponent(containerName)}/json`);
    if (!oldInfo || !oldInfo.Id) { log('Failed to inspect container.', 'error'); finishUpdate(containerName, 'failed'); return; }
    const wasRunning = oldInfo.State && oldInfo.State.Running;

    // 3. STOP OLD (only if running)
    if (wasRunning) {
      log(`Stopping "${containerName}" …`, 'info');
      await dockerApi('POST', `/containers/${oldInfo.Id}/stop?t=10`);
    } else {
      log(`Container "${containerName}" was not running, skipping stop.`, 'info');
    }

    // 4. RENAME OLD
    const oldName = containerName + '_old_' + Date.now();
    log(`Renaming old container to "${oldName}" …`, 'info');
    await dockerApi('POST', `/containers/${oldInfo.Id}/rename?name=${encodeURIComponent(oldName)}`);

    // 5. CREATE NEW (CLONE CONFIG)
    log(`Creating new container "${containerName}" …`, 'info');

    const config = { ...oldInfo.Config };
    config.Image = image;

    const createBody = {
      ...config,
      HostConfig: oldInfo.HostConfig,
      NetworkingConfig: {
        EndpointsConfig: oldInfo.NetworkSettings.Networks
      }
    };

    // Remove runtime-only or conflicting fields
    delete createBody.Hostname;

    const createRes = await dockerApi('POST', `/containers/create?name=${encodeURIComponent(containerName)}`, { body: createBody });
    if (createRes.statusCode !== 201) {
      log(`Create failed (HTTP ${createRes.statusCode}): ${JSON.stringify(createRes.body)}`, 'error');
      log(`Rollback: Renaming "${oldName}" back to "${containerName}" …`, 'warn');
      await dockerApi('POST', `/containers/${oldInfo.Id}/rename?name=${encodeURIComponent(containerName)}`);
      await dockerApi('POST', `/containers/${oldInfo.Id}/start`);
      finishUpdate(containerName, 'failed');
      return;
    }
    const newId = createRes.body.Id;

    // 6. START NEW (only if it was running before)
    if (wasRunning) {
      log(`Starting new container …`, 'info');
      const startRes = await dockerApi('POST', `/containers/${newId}/start`);
      if (startRes.statusCode < 200 || startRes.statusCode >= 300) {
        log(`Start failed: ${JSON.stringify(startRes.body)}`, 'error');
        finishUpdate(containerName, 'failed');
        return;
      }
    } else {
      log(`Container was not running before update, leaving it stopped.`, 'info');
    }

    // 7. CLEANUP OLD
    log(`Deleting old container …`, 'info');
    await dockerApi('DELETE', `/containers/${oldInfo.Id}?v=true`);

    log(`Update successful!`, 'ok');
    finishUpdate(containerName, 'done');

  } catch (err) {
    log(`Error: ${err.message}`, 'error');
    finishUpdate(containerName, 'failed');
  }
}

function finishUpdate(containerName, status) {
  const state = activeUpdates[containerName];
  if (!state) return;
  state.status = status;
  saveUpdateLog(containerName, { image: state.image, startedAt: state.startedAt, finishedAt: new Date().toISOString(), status, log: state.log });
  broadcastStatus(containerName, status);
  if (status === 'done') refreshCacheAfterUpdate(containerName, state.image);
  setTimeout(() => delete activeUpdates[containerName], 30000);
}

async function refreshCacheAfterUpdate(containerName, image) {
  try {
    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (!cache || !cache.results) return;
    const row = cache.results.find(r => r.container === containerName);
    if (!row) return;
    // Re-inspect the new container to get fresh local digest
    let localDigest = null;
    try {
      const inspect = await dockerApi('GET', `/images/${encodeURIComponent(image)}/json`);
      if (inspect.RepoDigests && inspect.RepoDigests.length > 0) {
        for (const d of inspect.RepoDigests) {
          const m = d.match(/@(sha256:[a-f0-9]+)/);
          if (m) { localDigest = m[1]; break; }
        }
      }
    } catch {}
    if (localDigest) {
      row.localDigest = localDigest;
      row.remoteDigest = localDigest;
    }
    row.result = 'UpToDate';
    cache.timestamp = new Date().toISOString();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) { console.warn('[cache] Failed to refresh after update:', e.message); }
}

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Docker Image Checker running on http://0.0.0.0:${PORT}`);
  scheduleNextAutoCheck();
});
