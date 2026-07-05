const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const pkg = require('../package.json');

const WARMED_UP = Symbol.for('opencode-mem-fallback-proxy.warmedup');

function parseJSONC(text) {
  let s = text.replace(/\/\/.*$/gm, '');
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');
  s = s.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(s);
}

function loadConfig() {
  const configPaths = [
    process.env.FALLBACK_PROXY_CONFIG,
    path.join(os.homedir(), '.config', 'opencode', 'opencode-mem-fallback.jsonc'),
    path.join(os.homedir(), '.config', 'opencode', 'opencode-mem-fallback.json'),
  ].filter(Boolean);

  for (const configPath of configPaths) {
    try {
      const text = fs.readFileSync(configPath, 'utf-8');
      const parsed = parseJSONC(text);

      if (!Array.isArray(parsed.backends) || parsed.backends.length === 0) {
        throw new Error('No backends defined in config');
      }
      for (let i = 0; i < parsed.backends.length; i++) {
        const b = parsed.backends[i];
        if (!b.url || !b.apiKey) {
          throw new Error(`Backend #${i + 1} ("${b.name || 'unnamed'}") missing url or apiKey`);
        }
      }

      console.log(`[mem-fallback-proxy] loaded config: ${configPath}`);
      return {
        port: parsed.port || 3000,
        host: parsed.host || '127.0.0.1',
        backends: parsed.backends,
      };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[mem-fallback-proxy] config error (${configPath}): ${err.message}`);
      }
    }
  }

  const backends = [];

  const primaryUrl = process.env.PRIMARY_URL;
  const primaryKey = process.env.PRIMARY_API_KEY || process.env.MANIFEST_API_KEY;
  if (primaryUrl && primaryKey) {
    backends.push({
      name: process.env.PRIMARY_NAME || 'Primary',
      url: primaryUrl,
      apiKey: primaryKey,
      timeout: parseInt(process.env.PRIMARY_TIMEOUT || '20000', 10),
      model: process.env.PRIMARY_MODEL || undefined,
    });
  }

  const fallbackUrl = process.env.FALLBACK_URL;
  const fallbackKey = process.env.FALLBACK_API_KEY || process.env.OPENCODE_GO_API_KEY;
  if (fallbackUrl && fallbackKey) {
    backends.push({
      name: process.env.FALLBACK_NAME || 'Fallback',
      url: fallbackUrl,
      apiKey: fallbackKey,
      timeout: parseInt(process.env.FALLBACK_TIMEOUT || '30000', 10),
      model: process.env.FALLBACK_MODEL || undefined,
    });
  }

  return {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '127.0.0.1',
    backends,
  };
}

function nodeFetch(url, key, body, timeoutMs) {
  const bodyStr = JSON.stringify(body);
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

async function tryBackend(backend, body) {
  const requestBody = backend.model ? { ...body, model: backend.model } : body;
  const response = await nodeFetch(backend.url, backend.apiKey, requestBody, backend.timeout || 30000);
  if (response.statusCode >= 400) {
    throw new Error(`${backend.name} HTTP ${response.statusCode}: ${(response.body || '').slice(0, 200)}`);
  }
  return response;
}

function createServer(cfg) {
  return http.createServer(async (req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host}`);
    if (req.method !== 'POST' || parsed.pathname !== '/v1/chat/completions') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    if (!cfg.backends.length) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No backends configured' }));
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
    const errors = [];

    for (const backend of cfg.backends) {
      try {
        const response = await tryBackend(backend, body);
        console.log(`[mem-fallback-proxy] ${now} ${backend.name} OK`);
        res.writeHead(response.statusCode, { 'Content-Type': 'application/json' });
        res.end(response.body);
        return;
      } catch (err) {
        console.warn(`[mem-fallback-proxy] ${now} ${backend.name} failed: ${err.message}`);
        errors.push({ name: backend.name, error: err.message });
      }
    }

    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'All backends failed', backendErrors: errors }));
  });
}

let server = null;

async function plugin(ctx, opts) {
  if (globalThis[WARMED_UP]) return {};
  globalThis[WARMED_UP] = true;

  try {
    const cfg = loadConfig();

    if (!cfg.backends.length) {
      console.warn('[mem-fallback-proxy] No backends configured; proxy not started. Create ~/.config/opencode/opencode-mem-fallback.jsonc');
      return {};
    }

    server = createServer(cfg);
    server.listen(cfg.port, cfg.host, () => {
      console.log(`[mem-fallback-proxy] listening on http://${cfg.host}:${cfg.port}/v1/chat/completions`);
      console.log(`[mem-fallback-proxy] ${cfg.backends.length} backend(s):`);
      for (const b of cfg.backends) {
        console.log(`[mem-fallback-proxy]   ${b.name} -> ${b.url}${b.model ? ` (model: ${b.model})` : ''}`);
      }
    });
  } catch (err) {
    console.error(`[mem-fallback-proxy] failed to start: ${err.message}`);
  }

  return {
    cleanup: () => {
      if (server) {
        server.close();
        server = null;
        console.log('[mem-fallback-proxy] stopped');
      }
    },
  };
}

module.exports = { id: pkg.name, server: plugin, default: { id: pkg.name, server: plugin } };
