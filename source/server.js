const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// ---------------------------------------------------------------------------
// JSON store — every persisted file goes through one of these.
//
// Writes land in a temp file that is then renamed over the target. rename() is
// atomic, so a crash mid-write can no longer leave a half-written config
// behind. Reads are kept in memory for `ttl` ms after last access, and a file
// that exists but cannot be parsed is reported instead of silently turning
// into an empty object — that failure mode used to lose settings in silence.
// ---------------------------------------------------------------------------
function createJsonStore(filePath, fallback, ttl = 300000) {
  const name = path.basename(filePath);
  let data = null, timer = null;

  function touch() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { data = null; timer = null; }, ttl);
  }

  return {
    load() {
      if (data !== null) { touch(); return data; }
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT') {
          console.warn(`[store] ${name} could not be read (${e.message}) — falling back to the default.`);
        }
        data = fallback();
      }
      touch();
      return data;
    },

    // Persists `value` and keeps it as the cached copy. Returns false if the
    // write failed, in which case the file on disk is left untouched.
    save(value) {
      const tmp = `${filePath}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
        fs.renameSync(tmp, filePath);
      } catch (e) {
        console.warn(`[store] Failed to save ${name}: ${e.message}`);
        try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
        return false;
      }
      data = value;
      touch();
      return true;
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
const TELEGRAM_TEMPLATE_FILE = path.join(DATA_DIR, 'telegram-template.json');

const DEFAULT_TELEGRAM_TEMPLATE = '<b>Update available!</b>\n\n' +
  'Container: <code>{container}</code>\n' +
  'Image: <code>{image}</code>\n' +
  'Registry: {registry}\n' +
  'Tag: {tag}';

const CONTAINER_NOTIFY_FILE = path.join(DATA_DIR, 'container-notify.json');
const ACTIVITY_LOG_FILE = path.join(DATA_DIR, 'activity.jsonl');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

// Ensure data directory exists
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.warn('[init] Could not create data dir:', e.message); }

app.use(express.json());

// ---------------------------------------------------------------------------
// Persisted state — all of it lives in DATA_DIR, all of it goes through a store
// ---------------------------------------------------------------------------
const RATE_LIMIT_FILE = path.join(DATA_DIR, 'rate-limits.json');

const resultStore = createJsonStore(CACHE_FILE, () => null);
const rateLimitStore = createJsonStore(RATE_LIMIT_FILE, () => ({}));
const updateLogsStore = createJsonStore(UPDATE_LOGS_FILE, () => ({}));
const telegramConfigStore = createJsonStore(TELEGRAM_CONFIG_FILE, () => ({ chats: [] }));
const telegramSentStore = createJsonStore(TELEGRAM_SENT_FILE, () => ({}));
const telegramTemplateStore = createJsonStore(TELEGRAM_TEMPLATE_FILE, () => ({ template: DEFAULT_TELEGRAM_TEMPLATE }));
const containerNotifyStore = createJsonStore(CONTAINER_NOTIFY_FILE, () => ({}));

// ---------------------------------------------------------------------------
// In-memory state for active updates
// { [containerName]: { image, status: 'running'|'done'|'failed', log: [{time,msg,type}], clients: [res] } }
// ---------------------------------------------------------------------------
const activeUpdates = {};

// ---------------------------------------------------------------------------
// Activity log (check summaries, update events, notification attempts)
// ---------------------------------------------------------------------------
function appendActivityLog(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  try { fs.appendFileSync(ACTIVITY_LOG_FILE, line); } catch (e) { console.warn('[activity-log] Failed to write:', e.message); }
}

// ---------------------------------------------------------------------------
// Registry rate-limit tracking
// ---------------------------------------------------------------------------

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
  const rateLimits = rateLimitStore.load();
  rateLimits[registry] = {
    limit: parse(limit),
    remaining: parse(remaining),
    updatedAt: new Date().toISOString()
  };
  rateLimitStore.save(rateLimits);
}

// ---------------------------------------------------------------------------
// Persistent update logs helpers (one entry per container)
// ---------------------------------------------------------------------------
function loadUpdateLogs() {
  return updateLogsStore.load();
}

function saveUpdateLog(container, entry) {
  const logs = loadUpdateLogs();
  logs[container] = entry;
  updateLogsStore.save(logs);
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

// The version label, in priority order. Images may carry any of these.
function pickVersionLabel(labels) {
  if (!labels) return null;
  return labels['org.opencontainers.image.version']
    || labels['org.label-schema.version']
    || labels['version']
    || null;
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

// ---------------------------------------------------------------------------
// Registry token cache — one token is valid for the whole manifest walk of a
// repo, so authenticating once per repo instead of once per lookup removes a
// round-trip (and an auth-server hit) for every image we check.
// ---------------------------------------------------------------------------
const TOKEN_TTL = 240000;
const tokenCache = new Map(); // `${registry}|${repo}` -> { authHeader, expiresAt }

function getCachedAuth(registry, repo) {
  const hit = tokenCache.get(`${registry}|${repo}`);
  return hit && hit.expiresAt > Date.now() ? hit : null;
}

function setCachedAuth(registry, repo, authHeader) {
  tokenCache.set(`${registry}|${repo}`, { authHeader, expiresAt: Date.now() + TOKEN_TTL });
}

// Resolve the manifest URL plus the auth headers to use with it.
// Returns null when the registry needs credentials we could not obtain.
async function resolveManifestRequest(registry, repo, tag) {
  const handler = getRegistryHandler(registry);
  const headers = { 'Accept': ACCEPT_HEADER };
  const manifestUrl = handler
    ? handler.getManifestUrl(repo, tag, registry)
    : `https://${registry}/v2/${repo}/manifests/${tag}`;

  const cached = getCachedAuth(registry, repo);
  if (cached) {
    if (cached.authHeader) headers['Authorization'] = cached.authHeader;
    return { manifestUrl, headers };
  }

  let token = null;
  if (handler) {
    token = await handler.authenticate(repo, registry, manifestUrl);
    // These registries never serve anonymous manifests, so a missing token is fatal.
    if (!token && (registry === 'docker.io' || registry === 'ghcr.io')) return null;
  } else {
    // Generic/unknown registry — probe for a challenge, then honour it.
    try {
      const probe = await httpsHead(manifestUrl, headers);
      if (probe.statusCode === 401 && probe.headers['www-authenticate']) {
        token = await getTokenFromChallenge(registry, repo, probe.headers['www-authenticate']);
        if (!token) return null;
      }
    } catch (e) {
      console.warn(`[digest] Generic registry probe failed for ${registry}:`, e.message);
      return null;
    }
  }

  const authHeader = token ? `Bearer ${token}` : null;
  setCachedAuth(registry, repo, authHeader);
  if (authHeader) headers['Authorization'] = authHeader;
  return { manifestUrl, headers };
}

// Walk manifest -> (platform manifest) -> config blob and read the version
// label. `topManifest` is the already-parsed top-level manifest, when the
// caller happens to have it; otherwise it is fetched here.
function warnVersion(manifestUrl, reason) {
  console.warn(`[version] Giving up on ${manifestUrl}: ${reason}`);
}

async function fetchVersionLabel(manifestUrl, headers, topManifest) {
  const baseUrl = manifestUrl.replace(/\/manifests\/[^/]+$/, '');
  try {
    let manifest = topManifest;
    if (!manifest) {
      const mres = await httpsGet(manifestUrl, headers);
      if (mres.statusCode !== 200) { warnVersion(manifestUrl, `manifest HTTP ${mres.statusCode}`); return null; }
      try { manifest = JSON.parse(mres.body); } catch { warnVersion(manifestUrl, 'manifest is not JSON'); return null; }
    }

    // Manifest list / OCI index: pick a platform-specific entry (linux/amd64 preferred)
    if (Array.isArray(manifest.manifests) && manifest.manifests.length > 0) {
      const pick = manifest.manifests.find(m => m.platform && m.platform.os === 'linux' && m.platform.architecture === 'amd64')
        || manifest.manifests.find(m => m.platform && m.platform.os === 'linux')
        || manifest.manifests[0];
      if (!pick || !pick.digest) return null;
      const pres = await httpsGet(`${baseUrl}/manifests/${pick.digest}`, headers);
      if (pres.statusCode !== 200) { warnVersion(manifestUrl, `platform manifest HTTP ${pres.statusCode}`); return null; }
      try { manifest = JSON.parse(pres.body); } catch { warnVersion(manifestUrl, 'platform manifest is not JSON'); return null; }
    }

    const configDigest = manifest.config && manifest.config.digest;
    if (!configDigest) return null;

    const bres = await httpsGet(`${baseUrl}/blobs/${configDigest}`, headers);
    if (bres.statusCode !== 200) { warnVersion(manifestUrl, `config blob HTTP ${bres.statusCode}`); return null; }
    let config;
    try { config = JSON.parse(bres.body); } catch { warnVersion(manifestUrl, 'config blob is not JSON'); return null; }

    const labels = (config.config && config.config.Labels) || (config.Config && config.Config.Labels) || null;
    return labels ? pickVersionLabel(labels) : null;
  } catch (e) {
    console.warn(`[version] Failed for ${manifestUrl}:`, e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Remote digest + version label in one pass.
//
// `known` may carry the digest/version this image resolved to on an earlier
// run. The version label is a property of the digest, so when the digest has
// not moved we reuse the known version and skip the manifest walk entirely —
// in the steady state a check then costs one HEAD per image instead of a
// manifest GET plus a platform manifest GET plus a config blob GET.
// ---------------------------------------------------------------------------
async function fetchRemoteInfo(registry, repo, tag, known = {}) {
  const prep = await resolveManifestRequest(registry, repo, tag);
  if (!prep) return { digest: null, version: null };
  const { manifestUrl, headers } = prep;

  let digest = null;
  let topManifest = null;

  // HEAD is enough for the digest and does not transfer the manifest body.
  try {
    const res = await httpsHead(manifestUrl, headers);
    updateRateLimit(registry, res.headers);
    if (res.statusCode === 200 && res.headers['docker-content-digest']) {
      digest = res.headers['docker-content-digest'].trim();
    }
  } catch (e) { console.warn(`[digest] HEAD failed for ${registry}/${repo}:${tag}:`, e.message); }

  // Fallback: GET the manifest and use its header, or hash the body ourselves.
  // The parsed body is kept so the version walk below need not refetch it.
  if (!digest) {
    try {
      const res = await httpsGet(manifestUrl, headers);
      updateRateLimit(registry, res.headers);
      if (res.statusCode === 200) {
        digest = res.headers['docker-content-digest']
          ? res.headers['docker-content-digest'].trim()
          : `sha256:${crypto.createHash('sha256').update(res.body).digest('hex')}`;
        try { topManifest = JSON.parse(res.body); } catch { /* not usable for the version walk */ }
      }
    } catch (e) { console.warn(`[digest] GET failed for ${registry}/${repo}:${tag}:`, e.message); }
  }

  if (!digest) return { digest: null, version: null };

  if (known.digest === digest && known.version) {
    return { digest, version: known.version, versionReused: true };
  }

  const version = await fetchVersionLabel(manifestUrl, headers, topManifest);
  return { digest, version };
}

// ---------------------------------------------------------------------------
// Shared check logic (used by both SSE endpoint and auto-check)
// ---------------------------------------------------------------------------
async function runCheck(includeStopped, { onTotal, onProgress, onResult } = {}) {
  // Load previous results: the digests drive update-event logging, and the
  // digest+version pairs let fetchRemoteInfo() skip the version walk for
  // images that have not moved since the last run.
  let prevDigests = {};
  const knownByImage = {};
  try {
    const prev = resultStore.load();
    if (prev && prev.results) {
      for (const r of prev.results) {
        prevDigests[r.container] = r.remoteDigest;
        const p = parseImageReference(r.image);
        if (p && r.remoteDigest && r.remoteDigest !== '-') {
          knownByImage[p.cacheKey] = {
            digest: r.remoteDigest,
            version: r.remoteVersion && r.remoteVersion !== '-' ? r.remoteVersion : null
          };
        }
      }
    }
  } catch { /* no previous cache */ }

  const containerList = await dockerApi('GET', `/containers/json?all=${includeStopped}`);
  if (onTotal) onTotal({ count: containerList.length });
  const infoCache = {};
  const results = [];
  for (let i = 0; i < containerList.length; i++) {
    const ctr = containerList[i];
    const name = (ctr.Names && ctr.Names[0]) ? ctr.Names[0].replace(/^\//, '') : ctr.Id.substring(0, 12);
    const image = ctr.Image;
    if (onProgress) onProgress({ index: i, total: containerList.length, container: name, image });
    const parsed = parseImageReference(image);
    if (!parsed) {
      const row = { container: name, image, state: ctr.State, status: ctr.Status, registry: '-', tag: '-', result: 'Pinned', localDigest: '-', remoteDigest: '-', ...getNotifyInfo(name, ctr.State) };
      results.push(row); if (onResult) onResult(row); continue;
    }
    let localDigest = null;
    let localVersion = null;
    const extractFromInspect = (inspect) => {
      if (inspect.RepoDigests && inspect.RepoDigests.length > 0) {
        for (const d of inspect.RepoDigests) {
          const m = d.match(/@(sha256:[a-f0-9]+)/);
          if (m) { localDigest = m[1]; break; }
        }
      }
      localVersion = pickVersionLabel((inspect.Config && inspect.Config.Labels) || null);
    };
    try {
      extractFromInspect(await dockerApi('GET', `/images/${encodeURIComponent(image)}/json`));
    } catch (e) {
      try {
        extractFromInspect(await dockerApi('GET', `/images/${ctr.ImageID}/json`));
      } catch (e2) { console.warn(`[check] Could not inspect image for ${name}:`, e2.message); }
    }
    let info, fromCache = false;
    if (infoCache.hasOwnProperty(parsed.cacheKey)) {
      info = infoCache[parsed.cacheKey]; fromCache = true;
    } else {
      const known = knownByImage[parsed.cacheKey] || {};
      info = await fetchRemoteInfo(parsed.registry, parsed.repo, parsed.tag, known);
      // Some registries only mirror; fall back to Docker Hub for the same repo.
      if (info.digest === null && parsed.registry !== 'docker.io') {
        info = await fetchRemoteInfo('docker.io', parsed.repo, parsed.tag, known);
      }
      infoCache[parsed.cacheKey] = info;
    }
    const remoteDigest = info.digest;
    const remoteVersion = info.version;
    let result = 'Unknown';
    if (remoteDigest === null) result = 'Unknown';
    else if (localDigest === null) result = 'NoLocalDigest';
    else if (localDigest === remoteDigest) result = 'UpToDate';
    else result = 'Outdated';
    const row = { container: name, image, state: ctr.State, status: ctr.Status, registry: parsed.registry, tag: parsed.tag, result, localDigest: localDigest || '-', remoteDigest: remoteDigest || '-', localVersion: localVersion || '-', remoteVersion: remoteVersion || '-', cached: fromCache, ...getNotifyInfo(name, ctr.State) };
    results.push(row); if (onResult) onResult(row);
  }
  const timestamp = new Date().toISOString();
  resultStore.save({ timestamp, results });
  const outdatedResults = results.filter(r => r.result === 'Outdated');
  appendActivityLog({ type: 'check', checked: results.length, outdated: outdatedResults.length });
  for (const r of outdatedResults) {
    if (prevDigests[r.container] !== r.remoteDigest) {
      appendActivityLog({ type: 'update-event', container: r.container, image: r.image, state: r.state, localDigest: r.localDigest, remoteDigest: r.remoteDigest });
    }
  }
  return { timestamp, results };
}

// ---------------------------------------------------------------------------
// Only one check may be in flight at a time.
//
// A manual check started while the auto-check is running would race it on
// last-result.json (one run's results silently lost), and both runs would send
// their own Telegram notifications for the same outdated containers. A second
// caller therefore attaches to the running check instead of starting its own:
// it gets the rows produced so far replayed, then follows along live.
// ---------------------------------------------------------------------------
let checkInFlight = null;

function runCheckExclusive(includeStopped, handlers = {}) {
  if (checkInFlight) {
    const run = checkInFlight;
    if (handlers.onTotal && run.total !== null) handlers.onTotal({ count: run.total });
    if (handlers.onResult) for (const row of run.produced) handlers.onResult(row);
    run.subscribers.add(handlers);
    return run.promise.finally(() => run.subscribers.delete(handlers));
  }

  const run = { total: null, produced: [], subscribers: new Set([handlers]) };
  const fanout = (name, arg) => {
    for (const sub of run.subscribers) {
      try { if (sub[name]) sub[name](arg); } catch (e) { console.warn('[check] Subscriber failed:', e.message); }
    }
  };

  run.promise = (async () => {
    try {
      const result = await runCheck(includeStopped, {
        onTotal: (t) => { run.total = t.count; fanout('onTotal', t); },
        onProgress: (p) => fanout('onProgress', p),
        onResult: (r) => { run.produced.push(r); fanout('onResult', r); }
      });
      // Notifications belong to the run, not to whoever asked for it — sending
      // them per caller would deliver one message per attached client.
      sendTelegramNotifications(result.results).catch(e => console.warn('[telegram] Notification error:', e.message));
      return result;
    } finally {
      checkInFlight = null;
    }
  })();

  checkInFlight = run;
  return run.promise;
}

app.get('/api/check', async (req, res) => {
  const includeStopped = req.query.includeStopped === 'true';
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    const result = await runCheckExclusive(includeStopped, {
      onTotal: (t) => send('total', t),
      onProgress: (p) => send('progress', p),
      onResult: (r) => send('result', r)
    });
    scheduleNextAutoCheck();
    send('done', { total: result.results.length });
  } catch (err) { send('error', { message: err.message }); }
  res.end();
});

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

function loadTelegramTemplate() {
  const data = telegramTemplateStore.load();
  return data && data.template ? data.template : DEFAULT_TELEGRAM_TEMPLATE;
}

function saveTelegramTemplate(template) { telegramTemplateStore.save({ template }); }

function renderTelegramTemplate(template, row) {
  const tokens = {
    container: row.container, image: row.image, registry: row.registry, tag: row.tag,
    state: row.state, status: row.status,
    localDigest: row.localDigest, remoteDigest: row.remoteDigest,
    localVersion: row.localVersion, remoteVersion: row.remoteVersion
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

// Telegram API endpoints
app.get('/api/telegram/config', (_req, res) => {
  // hasToken is derived, not stored — copy so it does not end up in the file.
  res.json({ ...loadTelegramConfig(), hasToken: !!TELEGRAM_BOT_TOKEN });
});

app.post('/api/telegram/config', (req, res) => {
  const config = req.body;
  if (!config || !Array.isArray(config.chats)) return res.status(400).json({ error: 'Invalid config' });
  // The client echoes back the derived token flags; they are not config.
  delete config.hasToken;
  delete config._hasToken;
  saveTelegramConfig(config);
  res.json({ ok: true });
});

app.post('/api/telegram/test', async (req, res) => {
  const { chatId } = req.body;
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  if (!TELEGRAM_BOT_TOKEN) return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not configured' });
  try {
    const template = loadTelegramTemplate();
    const mockRow = { container: 'my-awesome-app', image: 'nginx:latest', registry: 'docker.io', tag: 'latest', state: 'running', status: 'Up 3 days', localDigest: 'sha256:abc123...', remoteDigest: 'sha256:def456...' };
    const text = renderTelegramTemplate(template, mockRow);
    const result = await sendTelegramMessage(chatId, text);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/telegram/template', (_req, res) => {
  res.json({ template: loadTelegramTemplate(), default: DEFAULT_TELEGRAM_TEMPLATE });
});

app.post('/api/telegram/template', (req, res) => {
  const { template } = req.body;
  if (typeof template !== 'string') return res.status(400).json({ error: 'template string required' });
  saveTelegramTemplate(template);
  res.json({ ok: true });
});

app.post('/api/telegram/template/send', async (req, res) => {
  const { chatId, template, container } = req.body;
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  if (!template) return res.status(400).json({ error: 'template required' });
  if (!TELEGRAM_BOT_TOKEN) return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not configured' });
  let row;
  if (container) {
    try {
      const cache = resultStore.load();
      row = cache && cache.results && cache.results.find(r => r.container === container);
    } catch {}
  }
  if (!row) {
    row = { container: 'my-awesome-app', image: 'nginx:latest', registry: 'docker.io', tag: 'latest', state: 'running', status: 'Up 3 days', localDigest: 'sha256:abc123...', remoteDigest: 'sha256:def456...' };
  }
  try {
    const text = renderTelegramTemplate(template, row);
    const result = await sendTelegramMessage(chatId, text);
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
// Global SSE event bus (for pushing auto-check results to all connected clients)
// ---------------------------------------------------------------------------
const eventClients = [];

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(':ok\n\n');
  eventClients.push(res);
  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { /* disconnected */ }
  }, 25000);
  req.on('close', () => {
    clearInterval(keepalive);
    const idx = eventClients.indexOf(res);
    if (idx !== -1) eventClients.splice(idx, 1);
  });
});

function broadcastEvent(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of eventClients) {
    try { client.write(payload); } catch { /* disconnected */ }
  }
}

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
  const dh = rateLimitStore.load()['docker.io'];
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
    const cache = resultStore.load();
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
    broadcastEvent('auto-check-start', {});
    try {
      const autoResult = await runCheckExclusive(true);
      console.log('Auto-check complete.');
      broadcastEvent('auto-check-done', { timestamp: autoResult.timestamp, count: autoResult.results.length });
    } catch (e) {
      console.error('Auto-check failed:', e.message);
      broadcastEvent('auto-check-done', { error: e.message });
    }
    scheduleNextAutoCheck();
  }, delay);
}

app.get('/api/next-check', (_req, res) => {
  res.json({ nextAutoCheck: nextAutoCheckTime, intervalMs: getAutoCheckInterval(), fastMinutes: AUTO_CHECK_FAST_MINUTES, slowMinutes: AUTO_CHECK_SLOW_MINUTES });
});

app.get('/api/rate-limits', (_req, res) => {
  res.json(rateLimitStore.load());
});

app.get('/api/last-result', (_req, res) => {
  const cache = resultStore.load();
  if (!cache) return res.json(null);
  // Copy the rows: the store hands out its cached object, and mutating it here
  // would write the notify flags back to disk on the next save.
  const results = (cache.results || []).map(row => ({ ...row, ...getNotifyInfo(row.container, row.state) }));
  res.json({ ...cache, results });
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
  // Lines carrying an id update the existing entry in place (live progress),
  // so the persisted log stays compact instead of growing one entry per tick.
  if (line.id) {
    const existing = state.log.find(l => l.id === line.id);
    if (existing) { existing.msg = line.msg; existing.type = line.type; existing.time = line.time; existing.bar = line.bar; }
    else state.log.push(line);
  } else {
    state.log.push(line);
  }
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
  const log = (msg, type = 'info', id, bar) => broadcastLog(containerName, { time: new Date().toISOString(), msg, type, ...(id ? { id } : {}), ...(bar ? { bar } : {}) });

  try {
    // 1. PULL IMAGE
    const parsed = parseImageReference(image);
    if (!parsed) {
      log(`Image pinned by digest (${image}), skipped pull.`, 'warn');
    } else {
      let fromImage = (parsed.registry === 'docker.io') ? (parsed.repo.startsWith('library/') ? parsed.repo.substring(8) : parsed.repo) : `${parsed.registry}/${parsed.repo}`;
      log(`Pulling ${fromImage}:${parsed.tag} …`, 'info');
      let failed = false;
      // The Docker pull stream emits one event per layer status change (often
      // hundreds per second). Instead of one log line each, we keep per-layer
      // state and render in-place updating progress bars: one aggregate bar
      // ('pull-overall') plus one bar per layer ('pull-layer-<id>'). Each layer
      // tracks its download and extract byte progress separately.
      const fmtBytes = (n) => {
        if (n == null) return '';
        const u = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = 0, v = n;
        while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
        return (i === 0 ? v : (v >= 10 ? Math.round(v) : v.toFixed(1))) + u[i];
      };
      const shortId = (id) => id.length > 12 ? id.slice(0, 12) : id;
      const layers = {};        // id -> { phase, dlCur, dlTot, exCur, exTot, terminal }
      const seenMessages = new Set();
      const lastEmit = {};      // log id -> last emitted pct (throttle)

      const layerPct = (L) => {
        if (L.phase === 'done' || L.phase === 'downloaded') return 100;
        if (L.phase === 'extracting') return L.exTot ? Math.round(L.exCur / L.exTot * 100) : 0;
        if (L.phase === 'downloading') return L.dlTot ? Math.round(L.dlCur / L.dlTot * 100) : 0;
        return 0;
      };
      const layerLabel = (L) => ({
        pending: 'Waiting', downloading: 'Downloading',
        downloaded: 'Download complete', extracting: 'Extracting',
        done: L.terminal || 'Pull complete'
      })[L.phase] || '';
      const layerRight = (L) => {
        if (L.phase === 'downloading' && L.dlTot) return `${fmtBytes(L.dlCur)} / ${fmtBytes(L.dlTot)}`;
        if (L.phase === 'extracting' && L.exTot) return `${Math.round(L.exCur / L.exTot * 100)}%`;
        return '';
      };
      const emitLayer = (id) => {
        const L = layers[id], key = 'pull-layer-' + id, pct = layerPct(L);
        const sig = L.phase + ':' + pct;
        if (lastEmit[key] === sig) return;
        lastEmit[key] = sig;
        log('', L.phase === 'done' ? 'ok' : 'info', key, { pct, left: `${shortId(id)}  ${layerLabel(L)}`, right: layerRight(L) });
      };
      const emitOverall = (force) => {
        const ids = Object.keys(layers);
        if (!ids.length) return;
        let frac = 0, done = 0, sumCur = 0, sumTot = 0;
        for (const id of ids) {
          const L = layers[id];
          if (L.phase === 'done') { frac += 1; done++; }
          else if (L.phase === 'extracting') frac += 0.5 + 0.5 * (L.exTot ? L.exCur / L.exTot : 0);
          else if (L.phase === 'downloaded') frac += 0.5;
          else if (L.phase === 'downloading') frac += 0.5 * (L.dlTot ? L.dlCur / L.dlTot : 0);
          if (L.dlTot) { sumCur += L.dlCur; sumTot += L.dlTot; }
        }
        const pct = Math.round(frac / ids.length * 100);
        // Throttle on pct AND done: fractional credit can push pct to 100 while
        // layers are still extracting, so keying on pct alone would freeze the
        // "X / Y complete" label once that happens.
        const sig = pct + ':' + done;
        if (!force && lastEmit['pull-overall'] === sig) return;
        lastEmit['pull-overall'] = sig;
        const right = sumTot ? `${fmtBytes(sumCur)} / ${fmtBytes(sumTot)}` : '';
        log('', done === ids.length ? 'ok' : 'info', 'pull-overall', { pct, left: `Layers  ${done} / ${ids.length} complete`, right });
      };

      const pullCode = await dockerApi('POST', `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(parsed.tag)}`, {
        stream: (chunk) => {
          if (chunk.error) { log(`Pull error: ${chunk.error}`, 'error'); failed = true; return; }
          if (!chunk.status) return;
          if (!chunk.id) {
            // Non-layer status (e.g. "Pulling from repo", "Digest: …", "Status: …"); log once.
            if (!seenMessages.has(chunk.status)) { seenMessages.add(chunk.status); log(chunk.status, 'info'); }
            return;
          }
          const id = chunk.id;
          const pd = chunk.progressDetail || {};
          // Build on a copy and only commit to `layers` once we've handled the
          // status — otherwise an unmapped status on a fresh id would register a
          // phantom 'pending' layer that inflates the total but never completes.
          const L = layers[id] || { phase: 'pending', dlCur: 0, dlTot: 0, exCur: 0, exTot: 0 };
          switch (chunk.status) {
            case 'Pulling fs layer': case 'Waiting': L.phase = 'pending'; break;
            case 'Downloading': L.phase = 'downloading'; if (pd.current != null) L.dlCur = pd.current; if (pd.total) L.dlTot = pd.total; break;
            case 'Verifying Checksum': L.phase = 'downloading'; break;
            case 'Download complete': L.phase = 'downloaded'; if (L.dlTot) L.dlCur = L.dlTot; break;
            case 'Extracting': L.phase = 'extracting'; if (pd.current != null) L.exCur = pd.current; if (pd.total) L.exTot = pd.total; break;
            case 'Pull complete': L.phase = 'done'; L.terminal = 'Pull complete'; break;
            case 'Already exists': L.phase = 'done'; L.terminal = 'Already exists'; break;
            default: return; // unknown status — ignore, don't register a phantom layer
          }
          layers[id] = L;
          emitOverall();   // emitted first so the aggregate bar stays on top
          emitLayer(id);
        }
      });
      if (failed || pullCode !== 200) { log('Pull failed.', 'error'); finishUpdate(containerName, 'failed'); return; }
      emitOverall(true);   // force a final flush so the aggregate bar always lands on 100%
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

    // Docker bakes the image's labels into the container config at create time,
    // so a plain clone would freeze the OLD image's labels (e.g. a stale
    // org.opencontainers.image.version) onto the new container. Drop every label
    // whose value is identical to the old image's — those are purely inherited,
    // and the new image will supply its own. Labels the user set explicitly
    // (compose labels, reverse-proxy rules, or an intentional override with a
    // different value) are kept untouched.
    if (config.Labels && oldInfo.Image) {
      try {
        const oldImg = await dockerApi('GET', `/images/${encodeURIComponent(oldInfo.Image)}/json`);
        const imgLabels = (oldImg.Config && oldImg.Config.Labels) || null;
        if (imgLabels) {
          const labels = { ...config.Labels };
          let dropped = 0;
          // Build-metadata namespaces are always image-provided provenance; a
          // container-level override of them is never intentional, and a value
          // mismatch there just means the label got frozen by an *earlier* swap.
          const isProvenance = (k) => k.startsWith('org.opencontainers.image.')
            || k.startsWith('org.label-schema.');
          for (const k of Object.keys(imgLabels)) {
            if (labels[k] === imgLabels[k] || isProvenance(k)) { delete labels[k]; dropped++; }
          }
          for (const k of Object.keys(labels)) {
            if (isProvenance(k)) { delete labels[k]; dropped++; }
          }
          if (dropped) log(`Dropped ${dropped} label(s) inherited from the old image, the new image provides its own.`, 'info');
          config.Labels = labels;
        }
      } catch (e) { log(`Could not read old image labels (${e.message}), cloning them as-is.`, 'warn'); }
    }

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

async function finishUpdate(containerName, status) {
  const state = activeUpdates[containerName];
  if (!state) return;
  state.status = status;
  const finishedAt = new Date().toISOString();
  saveUpdateLog(containerName, { image: state.image, startedAt: state.startedAt, finishedAt, status, log: state.log });
  appendActivityLog({ type: 'update-install', container: containerName, image: state.image, status, startedAt: state.startedAt, finishedAt });
  // Refresh the cache BEFORE broadcasting: on 'done' the UI immediately reads
  // /api/last-result back, so the fresh digest/version must already be in there
  // — otherwise it would render the pre-update values.
  if (status === 'done') {
    await refreshCacheAfterUpdate(containerName, state.image);
    clearTelegramSentForContainer(containerName);
  }
  broadcastStatus(containerName, status);
  setTimeout(() => delete activeUpdates[containerName], 30000);
}

async function refreshCacheAfterUpdate(containerName, image) {
  try {
    const cache = resultStore.load();
    if (!cache || !cache.results) return;
    const row = cache.results.find(r => r.container === containerName);
    if (!row) return;
    // Re-inspect the pulled image to get fresh local digest + OCI version label
    let localDigest = null, localVersion = null;
    try {
      const inspect = await dockerApi('GET', `/images/${encodeURIComponent(image)}/json`);
      if (inspect.RepoDigests && inspect.RepoDigests.length > 0) {
        for (const d of inspect.RepoDigests) {
          const m = d.match(/@(sha256:[a-f0-9]+)/);
          if (m) { localDigest = m[1]; break; }
        }
      }
      localVersion = pickVersionLabel((inspect.Config && inspect.Config.Labels) || null);
    } catch (e) { console.warn('[cache] Could not inspect image after update:', e.message); }
    if (localDigest) {
      row.localDigest = localDigest;
      row.remoteDigest = localDigest;
    }
    // The container now runs exactly this image, so the "Detected" column must
    // show its label — otherwise the pre-update value lingers until the next check.
    row.localVersion = localVersion || '-';
    if (localDigest) row.remoteVersion = row.localVersion;
    row.result = 'UpToDate';
    // Refresh state/status too: the row otherwise keeps the old container's uptime.
    try {
      const ctr = await dockerApi('GET', `/containers/${encodeURIComponent(containerName)}/json`);
      if (ctr && ctr.State) {
        row.state = ctr.State.Status || row.state;
        row.status = ctr.State.Running
          ? 'Up (just updated)'
          : (ctr.State.Status ? ctr.State.Status.charAt(0).toUpperCase() + ctr.State.Status.slice(1) : row.status);
      }
    } catch (e) { console.warn('[cache] Could not inspect container after update:', e.message); }
    cache.timestamp = new Date().toISOString();
    resultStore.save(cache);
  } catch (e) { console.warn('[cache] Failed to refresh after update:', e.message); }
}

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Docker Image Checker running on http://0.0.0.0:${PORT}`);
  scheduleNextAutoCheck();
});
