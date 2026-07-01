# Independent Package Checklist

`@codex-provider/core` remains internal-only until this checklist is complete.

## Release Gate

- [x] `private: true` is retained while the API is still stabilizing.
- [x] Root `exports` exposes only the stable root entrypoint and `./package.json`.
- [x] Historical `CodexGateway*` server/trace names remain available as deprecated aliases.
- [x] Formal `CodexProviderRelay*` server/trace names are exported from the root entrypoint.
- [x] Formal `CodexProvider*` public API aliases are exported from the root entrypoint.
- [x] Package metadata uses `@codex-provider/core` and `0.1.0-alpha.0` while retaining `private: true`.
- [x] New `codex-provider:*` root scripts exist and legacy `codex-provider-relay:*` scripts remain.
- [x] Built-in hosted tools require explicit declarations.
- [x] Relay-emulated hosted tools require explicit executors.
- [x] Unsafe tools have no default executor.
- [x] No sqlite driver, vector database driver, browser controller, shell sandbox, or image provider dependency is bundled.
- [x] Examples live outside `src` and do not pull host-app session/UI logic into the package.
- [x] Live smoke recipe documentation exists for upstream, web search, file search, image generation, and unsafe-tool default checks.
- [x] Unsafe tool security notes exist for code interpreter, computer, shell, and apply-patch boundaries.
- [x] Draft release readiness policy exists.
- [ ] Live smoke recipes are executed and recorded against real upstream providers.
- [ ] Live consumer validation is completed through CodexNext or a standalone app-server harness.
- [ ] Changelog policy and npm release workflow are decided.

## Consumer Boundary

The package owns:

- Codex provider profile construction.
- Responses-to-Chat and Chat-to-Responses protocol conversion.
- Local Responses adapter runtime.
- Explicit hosted tool declaration and executor registry.
- Built-in relay-emulated executor contracts.
- Search, file-search, image-generation, code-interpreter, and computer-use adapter interfaces.

The package does not own:

- CodexBridge, CodexNext, or any host UI state.
- Chat session persistence.
- WeChat, Telegram, browser, desktop, or mobile transports.
- User approval UX.
- Host sandbox implementation.
- Secret storage.
- External index deployment.

## Public Surface Policy

Prefer adding new root exports over subpath exports until the package reaches a stable semver release. Internal folders can be refactored without breaking consumers as long as the root entrypoint remains compatible.

Deprecated names must stay as type/function aliases for at least one stabilization cycle after the package becomes publishable.

## Current Blocker

The public package name is now `@codex-provider/core`, but the package remains internal-only. Keep `private: true`, keep `version: "0.1.0-alpha.0"`, and avoid adding new public subpath exports until live smoke and external consumer validation are complete.
