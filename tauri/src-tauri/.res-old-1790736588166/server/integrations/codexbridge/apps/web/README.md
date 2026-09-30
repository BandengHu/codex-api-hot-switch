# CodexBridge Web Console

Thin Next.js control panel on top of the existing CodexBridge core.

## Default port

- `58888`
- Host: `0.0.0.0`
- Browser URL example: `http://YOUR_SERVER_IP:58888/login`

## Required auth env

Set these before starting the web console:

```bash
export CODEXBRIDGE_WEB_USERNAME=admin
export CODEXBRIDGE_WEB_PASSWORD='replace-with-a-strong-password'
```

Optional:

```bash
export CODEXBRIDGE_WEB_SESSION_SECRET='replace-with-a-long-random-secret'
export CODEXBRIDGE_WEB_COOKIE_SECURE=1
```

## Run

From the repo root:

```bash
pnpm --dir apps/web install
pnpm --dir apps/web dev
```

Or use the root helper scripts:

```bash
pnpm web:dev
pnpm web:build
pnpm web:start
```

## Scope of the first cut

- Session list
- Session detail with bindings / automations / related assistant records
- Automation list
- Runtime status
- Read-only JSON APIs

This first cut intentionally does not yet provide:

- browser-side message sending
- websocket streaming

For direct public exposure, put it behind HTTPS/reverse proxy instead of exposing plain HTTP long-term.
