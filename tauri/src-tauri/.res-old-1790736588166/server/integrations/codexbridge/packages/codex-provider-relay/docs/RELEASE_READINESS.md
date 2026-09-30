# Release Readiness

This package is still internal-only.

```json
{
  "name": "@codex-provider/core",
  "version": "0.1.0-alpha.0",
  "private": true
}
```

## Current Publish Position

- Keep `private: true`.
- Keep root `exports` limited to `.` and `./package.json`.
- Keep `CodexGateway*` aliases as deprecated compatibility names.
- Prefer `CodexProvider*` names for new consumers.
- Keep `CodexProviderRelay*` aliases as deprecated compatibility names during the stabilization cycle.
- Do not introduce subpath exports until the root API is stable.

## Open Decisions

- Public release version after alpha.
- Changelog format.
- Release automation.
- Whether examples are shipped in the npm tarball or only kept in the repository.

## Recommended Version Strategy

- Stay at `0.1.0-alpha.0` while `private: true`.
- Add `CHANGELOG.md`.
- Add a package export audit test for every stable root export.
- Run live smoke recipes and record redacted results.
- Publish only after at least one external host, such as CodexNext or a standalone app-server harness, consumes the package through the root entrypoint.

## Pre-Publish Command Gate

Run:

```bash
cd packages/codex-provider-relay
pnpm test
pnpm typecheck
pnpm build
```

If the package directory does not have its own `node_modules`, use the workspace root scripts or ensure the workspace bin directory is on `PATH`.

Also run from the repository root:

```bash
npm run codex-provider:test
npm run codex-provider:typecheck
npm run codex-provider:build
npm run codex-provider:check-boundary
npm run codex-provider-relay:check-boundary
git diff --check
```

## Tarball Inspection

Before removing `private: true`, inspect the package contents:

```bash
pnpm --dir packages/codex-provider-relay pack --dry-run
```

The tarball must include only:

- `dist`
- `README.md`
- `docs`
- `examples`, if intentionally shipped
- `package.json`

It must not include secrets, `.env` files, local indexes, generated caches, Telegram/WeChat artifacts, or host app source.
