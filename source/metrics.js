// ---------------------------------------------------------------------------
// Prometheus exposition.
//
// The endpoint is read-only by design: it renders whatever the last check left
// in the cache and never contacts a registry. Prometheus scrapes every few
// seconds, so a scrape that triggered a check would burn the Docker Hub pull
// quota in a single afternoon.
// ---------------------------------------------------------------------------
const { resultStore, rateLimitStore } = require('./store');

const PREFIX = 'docker_image_checker';

// Every result a row can carry. Emitted even at zero, so a query or an alert
// rule does not silently return nothing when a category happens to be empty.
const RESULT_KINDS = ['UpToDate', 'Outdated', 'Unknown', 'Pinned', 'NoLocalDigest'];

// Counters live in memory and restart at zero with the process. That is normal
// for Prometheus counters — rate() and increase() handle a reset.
const updateCounts = { success: 0, failed: 0 };
let lastCheckDurationSeconds = null;

function recordUpdate(status) {
  if (status === 'done') updateCounts.success++;
  else updateCounts.failed++;
}

function recordCheckDuration(seconds) {
  lastCheckDurationSeconds = seconds;
}

// Label values are quoted, so a backslash, a quote or a newline inside one
// would break the line. Container and image names cannot contain these today,
// but the exposition format is a contract with an outside system.
function escapeLabel(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function labels(pairs) {
  const parts = Object.keys(pairs)
    .filter(k => pairs[k] !== undefined && pairs[k] !== null)
    .map(k => `${k}="${escapeLabel(pairs[k])}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}

function renderMetrics() {
  const out = [];
  const metric = (name, type, help) => {
    out.push(`# HELP ${PREFIX}_${name} ${help}`);
    out.push(`# TYPE ${PREFIX}_${name} ${type}`);
  };
  const sample = (name, labelPairs, value) => {
    out.push(`${PREFIX}_${name}${labels(labelPairs)} ${value}`);
  };

  const cache = resultStore.load();
  const rows = (cache && cache.results) || [];

  metric('build_info', 'gauge', 'Build version of the running instance.');
  sample('build_info', { version: process.env.BUILD_VERSION || 'dev' }, 1);

  // Not "containers_total": in Prometheus the _total suffix belongs to counters,
  // and promtool rejects it on a gauge.
  metric('containers', 'gauge', 'Containers seen by the last check, by result.');
  const byResult = {};
  for (const kind of RESULT_KINDS) byResult[kind] = 0;
  for (const row of rows) {
    if (byResult[row.result] === undefined) byResult[row.result] = 0;
    byResult[row.result]++;
  }
  for (const kind of Object.keys(byResult)) sample('containers', { result: kind }, byResult[kind]);

  metric('container_outdated', 'gauge', 'Per container: 1 when a newer image is available, 0 otherwise.');
  for (const row of rows) {
    sample('container_outdated',
      { container: row.container, image: row.image, registry: row.registry },
      row.result === 'Outdated' ? 1 : 0);
  }

  // The single most useful series to alert on: it stops moving when the checker
  // has stopped checking, which is otherwise invisible from the outside.
  metric('last_check_timestamp_seconds', 'gauge', 'Unix time of the last completed check. 0 when no check has run yet.');
  const ts = cache && cache.timestamp ? Math.floor(new Date(cache.timestamp).getTime() / 1000) : 0;
  sample('last_check_timestamp_seconds', {}, Number.isFinite(ts) ? ts : 0);

  metric('last_check_duration_seconds', 'gauge', 'Wall-clock duration of the last check in this process. -1 before the first one.');
  sample('last_check_duration_seconds', {}, lastCheckDurationSeconds === null ? -1 : lastCheckDurationSeconds.toFixed(3));

  const rateLimits = rateLimitStore.load();
  metric('registry_rate_limit_remaining', 'gauge', 'Remaining pulls reported by the registry.');
  for (const registry of Object.keys(rateLimits)) {
    const info = rateLimits[registry];
    if (info && info.remaining !== null && info.remaining !== undefined) {
      sample('registry_rate_limit_remaining', { registry }, info.remaining);
    }
  }
  metric('registry_rate_limit_limit', 'gauge', 'Pull limit reported by the registry.');
  for (const registry of Object.keys(rateLimits)) {
    const info = rateLimits[registry];
    if (info && info.limit !== null && info.limit !== undefined) {
      sample('registry_rate_limit_limit', { registry }, info.limit);
    }
  }

  metric('updates_total', 'counter', 'Container updates run by this instance since start.');
  sample('updates_total', { result: 'success' }, updateCounts.success);
  sample('updates_total', { result: 'failed' }, updateCounts.failed);

  return out.join('\n') + '\n';
}

module.exports = { renderMetrics, recordUpdate, recordCheckDuration };
