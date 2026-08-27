// ---------------------------------------------------------------------------
// Everything that talks to the Docker daemon over its unix socket.
// ---------------------------------------------------------------------------
const http = require('http');

const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
// Idle timeouts, not total-duration limits: the socket only trips when nothing
// arrives for this long. A pull is streamed, and while several run in parallel
// the daemon deduplicates shared layers — the losing pull then sits silent in
// "Waiting" for minutes. 30s used to kill it there, which is what made a batch
// of updates fail and then succeed on the retry, so streams get their own,
// far more generous stall budget.
const DOCKER_TIMEOUT = parseInt(process.env.DOCKER_TIMEOUT_MS, 10) || 30000;
const DOCKER_STREAM_STALL_MS = parseInt(process.env.DOCKER_STREAM_STALL_MS, 10) || 600000;

// ---------------------------------------------------------------------------
// Unified Docker socket helper
// ---------------------------------------------------------------------------
function dockerApi(method, apiPath, { body, stream, timeout } = {}) {
  return new Promise((resolve, reject) => {
    // Guard every settle: a socket error after the response ended would
    // otherwise reject an already-resolved promise (an unhandled rejection).
    let settled = false;
    const done = (fn, arg) => { if (settled) return; settled = true; fn(arg); };
    const ok = (v) => done(resolve, v);
    const fail = (e) => done(reject, e);
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
          ok(res.statusCode);
        });
        // A socket dropped mid-stream ends without 'end'; surface it as an error
        // instead of silently reporting a truncated pull as complete.
        res.on('error', (e) => fail(new Error(`Docker stream error on ${apiPath}: ${e.message}`)));
        return;
      }

      // Normal mode — collect body
      let rawBody = '';
      res.on('error', (e) => fail(new Error(`Docker response error on ${apiPath}: ${e.message}`)));
      res.on('data', (chunk) => (rawBody += chunk));
      res.on('end', () => {
        if (method === 'DELETE') {
          ok(res.statusCode);
          return;
        }
        // POST without body or with body — return statusCode + parsed body
        if (method === 'POST') {
          let parsed = null;
          try { parsed = JSON.parse(rawBody); } catch { /* not JSON */ }
          ok({ statusCode: res.statusCode, body: parsed || rawBody });
          return;
        }
        // GET — return parsed JSON
        try {
          ok(JSON.parse(rawBody));
        } catch (e) {
          fail(new Error(`Failed to parse Docker response for ${apiPath}: ${e.message}`));
        }
      });
    });

    const idleMs = timeout || (stream ? DOCKER_STREAM_STALL_MS : DOCKER_TIMEOUT);
    req.on('error', fail);
    req.setTimeout(idleMs, () => {
      req.destroy();
      fail(new Error(`Docker request timeout after ${Math.round(idleMs / 1000)}s of silence: ${method} ${apiPath}`));
    });

    if (data) req.write(data);
    req.end();
  });
}

module.exports = { dockerApi, DOCKER_SOCKET };
