// ---------------------------------------------------------------------------
// Everything that talks to the Docker daemon over its unix socket.
// ---------------------------------------------------------------------------
const http = require('http');

const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const DOCKER_TIMEOUT = 30000;

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

module.exports = { dockerApi, DOCKER_SOCKET };
