// ---------------------------------------------------------------------------
// Talking to container registries: HTTPS plumbing, per-registry auth, and
// resolving the remote digest and version label of an image.
// ---------------------------------------------------------------------------
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const { rateLimitStore } = require('./store');

const HTTPS_TIMEOUT = 15000;
const USER_AGENT = 'docker-image-checker/1.0';

const ACCEPT_HEADER = [
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json'
].join(', ');

const DOCKER_HUB_ALIASES = ['docker.io', 'index.docker.io', 'registry-1.docker.io', 'registry.hub.docker.com'];

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
        res.resume(); // drain, we only need the Location header
        // Location may be relative, so resolve it against the current URL.
        const target = new URL(res.headers.location, url);
        // Registry blob downloads redirect to a CDN or object store. Our bearer
        // token is scoped to the registry, so carrying it to a different host
        // would hand a credential to a third party — and some CDNs reject
        // requests that arrive with one.
        let nextHeaders = headers;
        if (target.host !== parsed.host) {
          nextHeaders = {};
          for (const [k, v] of Object.entries(headers)) {
            if (!/^authorization$/i.test(k)) nextHeaders[k] = v;
          }
        }
        return httpsRequest(method, target.href, nextHeaders, maxRedirects - 1).then(resolve).catch(reject);
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

module.exports = {
  httpsGet, httpsHead,
  parseImageReference, pickVersionLabel,
  fetchRemoteInfo,
  registryHandlers
};
