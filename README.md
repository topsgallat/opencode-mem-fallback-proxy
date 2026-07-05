# opencode-mem-fallback-proxy

An OpenCode plugin that starts a local HTTP proxy for `opencode-mem`. Routes requests through multiple backends in order — if the primary fails, the next backend is tried automatically.

Designed for setups with a free/self-hosted primary API and a paid fallback, so `opencode-mem` keeps working even when the primary is down.

## How it works

1. OpenCode loads this plugin at startup.
2. The plugin starts a local HTTP server (default: `127.0.0.1:3000`).
3. You set `opencode-mem`'s `memoryApiUrl` to point at this proxy.
4. When `opencode-mem` sends a request, the proxy tries each backend in order and returns the first successful response.
5. On shutdown, the plugin stops the server cleanly.

```
opencode-mem → localhost:3000 → Primary API (e.g. Manifest)
                                → Fallback API (e.g. OpenCode Go)
                                → Additional backends...
```

## Installation

### 1. Add the plugin to `opencode.json`

Because this plugin is not published on npm, use a `file:` reference pointing to your local clone:

```json
{
  "plugin": [
    // ... other plugins ...
    "file:/home/your-user/path/to/opencode-mem-fallback-proxy",
    "opencode-mem"
  ]
}
```

> `opencode-mem-fallback-proxy` should appear **before** `opencode-mem` in the list so it is loaded first.

### 2. Clone the repo

```bash
git clone https://github.com/topsgallat/opencode-mem-fallback-proxy.git /path/to/opencode-mem-fallback-proxy
```

Replace `/path/to/opencode-mem-fallback-proxy` with the path you used in the `file:` reference above.

### 3. Restart OpenCode

Restart the OpenCode service however it is managed on your system (s6, systemd, launchd, etc.).

Check that the proxy started:

```bash
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/v1/chat/completions \
  -X POST -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
```

Expect `200`.

## Configuration

Create `~/.config/opencode/opencode-mem-fallback.jsonc`:

```jsonc
{
  "port": 3000,
  "host": "127.0.0.1",

  "backends": [
    {
      "name": "Primary",
      "url": "https://primary.example.com/v1/chat/completions",
      "apiKey": "sk-primary-key",
      "timeout": 20000
    },
    {
      "name": "Fallback",
      "url": "https://fallback.example.com/v1/chat/completions",
      "apiKey": "sk-fallback-key",
      "timeout": 30000,
      "model": "gpt-4o-mini"
    }
  ]
}
```

### Config fields

| Field | Type | Default | Description |
|---|---|---|---|
| `port` | number | `3000` | Proxy listen port |
| `host` | string | `"127.0.0.1"` | Proxy listen address |
| `backends` | array | — | Ordered list of backends (tried in order) |

Each backend:

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | — | Label for logs |
| `url` | string | ✅ | Full chat completions URL (e.g. `http://host/v1/chat/completions`) |
| `apiKey` | string | ✅ | Bearer token sent as `Authorization: Bearer <key>` |
| `timeout` | number | — | Request timeout in ms (default: `30000`) |
| `model` | string | — | If set, overrides the `model` field in requests to this backend |

You can list as many backends as you want. The proxy tries them in array order.

### Setting `opencode-mem` to use the proxy

In your `opencode-mem.jsonc` (or equivalent config):

```jsonc
{
  "memoryProvider": "openai-chat",
  "memoryModel": "auto",
  "memoryApiUrl": "http://127.0.0.1:3000/v1",
  "memoryApiKey": "unused"
}
```

The `memoryApiKey` value is ignored by the proxy (each backend has its own key in the config file).

### Environment variables fallback

If no config file is found, the plugin falls back to these environment variables:

| Variable | Description |
|---|---|
| `PRIMARY_URL` | Primary backend URL |
| `PRIMARY_API_KEY` or `MANIFEST_API_KEY` | Primary backend API key |
| `PRIMARY_NAME` | Primary display name (default: `"Primary"`) |
| `PRIMARY_MODEL` | Model override for primary backend |
| `PRIMARY_TIMEOUT` | Timeout in ms for primary (default: `20000`) |
| `FALLBACK_URL` | Fallback backend URL |
| `FALLBACK_API_KEY` or `OPENCODE_GO_API_KEY` | Fallback backend API key |
| `FALLBACK_NAME` | Fallback display name (default: `"Fallback"`) |
| `FALLBACK_MODEL` | Model override for fallback backend |
| `FALLBACK_TIMEOUT` | Timeout in ms for fallback (default: `30000`) |
| `PORT` | Proxy listen port (default: `3000`) |
| `HOST` | Proxy listen address (default: `127.0.0.1`) |
| `FALLBACK_PROXY_CONFIG` | Custom path to config file |

## Example: Manifest API + OpenCode Go

Config file at `~/.config/opencode/opencode-mem-fallback.jsonc`:

```jsonc
{
  "port": 3000,
  "host": "127.0.0.1",

  "backends": [
    {
      "name": "Manifest API",
      "url": "http://172.17.0.1:2099/v1/chat/completions",
      "apiKey": "mnfst__your-manifest-key",
      "timeout": 20000,
      "model": "deepseek-ai/deepseek-v4-pro"
    },
    {
      "name": "OpenCode Go",
      "url": "https://opencode.ai/zen/go/v1/chat/completions",
      "apiKey": "sk-your-opencode-go-key",
      "timeout": 30000,
      "model": "deepseek-v4-flash"
    }
  ]
}
```

## Troubleshooting

**Proxy doesn't start:**
- Check `opencode.json` has the plugin listed.
- Verify the `file:` path points to the directory with `package.json` and `dist/plugin.js`.
- Check your OpenCode service status (e.g. `s6-svstat /run/service/opencode/` if using s6).

**All backends fail with "Request timed out":**
- Test each backend URL directly with curl.
- Check network connectivity between the host and each backend.

**opencode-mem reports "Unable to connect":**
- Confirm the proxy is listening: `curl http://127.0.0.1:3000/v1/chat/completions`
- Verify `opencode-mem`'s `memoryApiUrl` is `http://127.0.0.1:3000/v1`.
- Add the proxy plugin **before** `opencode-mem` in the plugin list so it loads first.

## License

MIT
