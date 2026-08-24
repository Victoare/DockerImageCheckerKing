// ---------------------------------------------------------------------------
// Persistence: where state lives on disk, and the store that guards it.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

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

const DATA_DIR = process.env.DATA_DIR || '/data';
const CACHE_FILE = path.join(DATA_DIR, 'last-result.json');
const UPDATE_LOGS_FILE = path.join(DATA_DIR, 'update-logs.json');
const RATE_LIMIT_FILE = path.join(DATA_DIR, 'rate-limits.json');
const ACTIVITY_LOG_FILE = path.join(DATA_DIR, 'activity.jsonl');

// Ensure data directory exists
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.warn('[init] Could not create data dir:', e.message); }

const resultStore = createJsonStore(CACHE_FILE, () => null);
const rateLimitStore = createJsonStore(RATE_LIMIT_FILE, () => ({}));
const updateLogsStore = createJsonStore(UPDATE_LOGS_FILE, () => ({}));

// ---------------------------------------------------------------------------
// Activity log (check summaries, update events, notification attempts)
// ---------------------------------------------------------------------------
// The log is append-only and every check adds to it, so on a long-running
// instance it grows without bound. Once it passes the limit the current file
// becomes the single .1 backup and a fresh one is started — two files' worth of
// history is kept, and old entries fall off the end instead of piling up.
const ACTIVITY_LOG_MAX_BYTES = 5 * 1024 * 1024;

let activityBytesSinceCheck = ACTIVITY_LOG_MAX_BYTES; // force a size check on the first write

function rotateActivityLogIfNeeded(incomingBytes) {
  activityBytesSinceCheck += incomingBytes;
  if (activityBytesSinceCheck < 64 * 1024) return; // don't stat on every line
  activityBytesSinceCheck = 0;
  try {
    const size = fs.statSync(ACTIVITY_LOG_FILE).size;
    if (size < ACTIVITY_LOG_MAX_BYTES) return;
    fs.renameSync(ACTIVITY_LOG_FILE, ACTIVITY_LOG_FILE + '.1');
    console.log(`[activity-log] Rotated at ${size} bytes.`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[activity-log] Rotation failed:', e.message);
  }
}

function rotateActivityLogIfNeeded(incomingBytes) {
  activityBytesSinceCheck += incomingBytes;
  if (activityBytesSinceCheck < 64 * 1024) return; // don't stat on every line
  activityBytesSinceCheck = 0;
  try {
    const size = fs.statSync(ACTIVITY_LOG_FILE).size;
    if (size < ACTIVITY_LOG_MAX_BYTES) return;
    fs.renameSync(ACTIVITY_LOG_FILE, ACTIVITY_LOG_FILE + '.1');
    console.log(`[activity-log] Rotated at ${size} bytes.`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[activity-log] Rotation failed:', e.message);
  }
}

function appendActivityLog(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  try {
    rotateActivityLogIfNeeded(Buffer.byteLength(line));
    fs.appendFileSync(ACTIVITY_LOG_FILE, line);
  } catch (e) { console.warn('[activity-log] Failed to write:', e.message); }
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

module.exports = {
  createJsonStore,
  DATA_DIR,
  resultStore, rateLimitStore, updateLogsStore,
  appendActivityLog,
  loadUpdateLogs, saveUpdateLog
};
