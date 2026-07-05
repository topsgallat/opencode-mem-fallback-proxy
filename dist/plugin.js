const http = require('http');
const https = require('https');

const pkg = require('../package.json');

// Prevent double-initialization (OpenCode calls plugin for warmup)
const WARMED_UP = Symbol.for('opencode-mem-fallback-proxy.warmedup');

const defaults = {
  port: parseInt(process.env.FALLBACK_PROXY_PORT || '3000', 10),
  primaryUrl: process.env.PRIMARY_URL || 'http://172.17.0.1:2099/v1/chat/completions',
  fallbackUrl: process.env.FALLBACK_URL || 'https://opencode.ai/zen/go/v1/chat/completions',
  primaryKey: process.env.MANIFEST_API_KEY,
  fallbackKey: process.env.OPENCODE_GO_API_KEY,
  primaryTimeout: parseInt(process.env.PRIMARY_TIMEOUT || '20000', 10),
  fallbackTimeout: parseInt(process.env.FALLBACK_TIMEOUT || '30000', 10),
};

function mapModel(model, backend) {
  if (model !== 'auto') return model;
  return backend === 'fallback' ? 'deepseek-v4-flash' : 'deepseek-ai/deepseek-v4-pro';
}

function nodeFetch(url, key, body, timeoutMs, model) {
  const bodyStr = JSON.stringify({ ...body, model });
  const parsed = new URL(url);
  const mod = parsed.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = mod.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'Content-Length': Buffer.byteLength(bodyStr),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        res.body = Buffer.concat(chunks).toString();
        resolve(res);
      });
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(bodyStr);
    req.end();
  });
}

async function tryBackend(url, key, body, timeoutMs, backendName) {
  const mappedModel = mapModel(body.model, backendName);
  const response = await nodeFetch(url, key, body, timeoutMs, mappedModel);
  if (response.statusCode >= 400) {
    throw new Error(`${backendName} HTTP ${response.statusCode}: ${(response.body || '').slice(0, 200)}`);
  }
  return response;
}

function createServer(cfg) {
  const { primaryUrl, primaryKey, primaryTimeout, fallbackUrl, fallbackKey, fallbackTimeout } = cfg;

  return http.createServer(async (req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host}`);
    if (req.method !== 'POST' || parsed.pathname !== '/v1/chat/completions') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    if (!primaryKey || !fallbackKey) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'MANIFEST_API_KEY and OPENCODE_GO_API_KEY must be set' }));
      return;
    }

    let body;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const now = new Date().toISOString();
    let lastError;

    try {
      const response = await tryBackend(primaryUrl, primaryKey, body, primaryTimeout, 'primary');
      console.log(`[mem-fallback-proxy] ${now} Primary (Manifest) OK`);
      res.writeHead(response.statusCode, { 'Content-Type': 'application/json' });
      res.end(response.body);
      return;
    } catch (err) {
      console.warn(`[mem-fallback-proxy] ${now} Primary failed: ${err.message}`);
      lastError = err;
    }

    try {
      const response = await tryBackend(fallbackUrl, fallbackKey, body, fallbackTimeout, 'fallback');
      console.log(`[mem-fallback-proxy] ${now} Fallback (OpenCode Go) OK`);
      res.writeHead(response.statusCode, { 'Content-Type': 'application/json' });
      res.end(response.body);
    } catch (err) {
      console.error(`[mem-fallback-proxy] ${now} Fallback failed: ${err.message}`);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Both backends failed',
        primaryError: lastError.message,
        fallbackError: err.message,
      }));
    }
  });
}

let server = null;

async function plugin(ctx, opts) {
  if (globalThis[WARMED_UP]) {
    return {};
  }
  globalThis[WARMED_UP] = true;

  const cfg = { ...defaults, ...(opts || {}) };

  if (cfg.primaryKey && cfg.fallbackKey) {
    server = createServer(cfg);
    server.listen(cfg.port, '127.0.0.1', () => {
      console.log(`[mem-fallback-proxy] proxy listening on http://127.0.0.1:${cfg.port}/v1/chat/completions`);
    });
  } else {
    console.warn('[mem-fallback-proxy] API keys not configured; proxy not started (set MANIFEST_API_KEY and OPENCODE_GO_API_KEY)');
  }

  return {
    cleanup: () => {
      if (server) {
        server.close();
        server = null;
        console.log('[mem-fallback-proxy] proxy stopped');
      }
    },
  };
}

module.exports = { id: pkg.name, server: plugin, default: { id: pkg.name, server: plugin } };
