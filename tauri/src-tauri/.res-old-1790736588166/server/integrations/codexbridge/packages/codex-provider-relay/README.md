# CodexProvider

`@codex-provider/core` is a provider compatibility SDK for Codex app-server integrations. It lets non-OpenAI models participate in the Codex native tool-call loop by exposing a Responses-compatible surface over provider-specific Chat Completions APIs.

Historical names under `@codexbridge/codex-provider-relay`, `CodexProviderRelay*`, and `CodexGateway*` remain as deprecated aliases during the stabilization cycle.

## Fixed Goal

Let non-OpenAI models participate in the Codex native tool-call loop.

This package exists so DeepSeek, OpenRouter, Claude-compatible relays, and other OpenAI-compatible upstreams can be used by Codex app-server while preserving the Codex loop:

```text
Codex app-server
  -> Responses API request and SSE events
  -> CodexProvider
  -> upstream provider API
  -> translated Responses events
  -> Codex local tool execution and continuation
```

## Non-Goals

- Do not merge `codex-native-api` into this package.
- Do not move host-app session stores, platform adapters, or Web UI state into this package.
- Do not pretend every upstream provider has OpenAI hosted tools.
- Do not hardcode host-app-specific runtime state.

## Canonical Strategy

The default strategy is `codex-local-first`.

Codex app-server remains responsible for local tools, approvals, workspace operations, MCP tools, and continuation orchestration. The relay is responsible for model protocol compatibility and tool-call event translation.

Provider-native tools and relay-emulated tools are explicit opt-ins:

- `codex-local-first`: keep Codex as the tool executor and translate model tool calls.
- `provider-native`: forward provider-supported hosted tools when the upstream truly supports them.
- `relay-emulated`: implement missing hosted tools in the relay or via MCP/search/file services.

`provider-native` and `relay-emulated` profiles must include explicit hosted tool declarations. A profile cannot silently claim hosted tool behavior just because a provider appears compatible.

## First Stable Surface

This package currently defines the fixed target, tool strategy types, protocol-aware Codex provider config builders, high-level official/mixed/pure API profile builders, Codex++-style local proxy URL helpers, protocol converters, provider capability presets, and the local Responses adapter server.

For `responses` upstreams, Codex provider `base_url` points at the upstream Responses endpoint. For `chat-completions` upstreams, Codex provider `base_url` points at this package's local Responses proxy, while the third-party Chat Completions endpoint remains relay-owned configuration. This is required so the Codex native tool-call loop passes through conversion instead of bypassing it.

`CodexProviderRuntime` starts and stops the built-in local Responses adapter server by default, exposes the local `baseUrl`, and returns Codex app-server launch config. Advanced hosts can still override `adapterServerFactory`, but CodexBridge, CodexNext, or any future app-server project no longer needs a second package to start the relay lifecycle.

Relay-emulated hosted tools now have a package-level executor registry. When a host declares `web_search` or `file_search` as `relay-emulated` and registers a matching executor, the local adapter exposes that capability to Chat Completions upstreams as a function tool, executes the returned tool call inside the relay, appends the tool output, and continues the upstream model loop before returning a Codex-compatible Responses result. Streaming clients keep a real streaming path: the relay consumes internal streamed tool-call deltas, runs the executor, then forwards the follow-up upstream answer stream through the existing Responses SSE translator.

Hosts that need UI observability can enable `emitHostedToolSseEvents`. This opt-in stream emits `hosted_tool.started`, `hosted_tool.delta`, `hosted_tool.completed`, and `hosted_tool.failed` before the normal Responses SSE events. The default stays off so Codex-compatible clients are not forced to accept non-standard event names.

Hosts can bring their own executor or use the built-in `createCodexProviderWebSearchExecutor` factory for Tavily, Brave Search, or Serper. The SDK only accepts keys through runtime options; it does not load or store provider secrets.

The built-in `createCodexProviderFileSearchExecutor` now accepts a generic `sources` list while preserving `roots` as a local-filesystem shortcut. The local filesystem source never scans the process working directory implicitly, skips common dependency/build/binary paths by default, avoids following symlinks unless enabled, rejects unsafe `path_glob` traversal, and bounds scanned files, bytes per file, total payload bytes, OpenAI-compatible chunk content, and result count. The memory-documents source lets hosts expose in-memory project notes, summaries, or session records through the same contract without binding the relay to a host app store. The SQLite FTS source accepts an injected `database.all(sql, params)` or custom `query()` function, so hosts can connect persistent FTS indexes without adding a sqlite driver dependency to this package.

Semantic `file_search` is now available through the generic `CodexProviderEmbeddingProvider` interface, `createCodexProviderInMemoryVectorFileSearchSource()`, and `createCodexProviderLocalVectorFileSearchSource()`. The local-vector source scans explicit roots with the same local-fs safety boundary, chunks files, embeds chunks, caches document/chunk embeddings in a pluggable `CodexProviderLocalVectorIndexStore`, and uses hybrid vector/lexical scoring at query time. `createCodexProviderMemoryLocalVectorIndexStore()` provides an in-memory store, and `createCodexProviderSqliteLocalVectorIndexStore()` provides a persistent SQLite store through host-injected `database.all/run` methods without adding a sqlite driver dependency. `createCodexProviderEmbeddingsApiProvider()` targets OpenAI-compatible embeddings APIs with host-provided endpoint, model, headers, and API key. The default endpoint/model currently points at OpenRouter's Qwen embedding API only as a convenient starter configuration, and `createCodexProviderOpenRouterEmbeddingProvider()` remains a thin convenience wrapper over the generic provider.

The profile surface exposes the safe presets app-servers should use:

| Mode | Codex auth | Upstream protocol | Local adapter | Use case |
| --- | --- | --- | --- | --- |
| `official` | `codex-auth-compatible` | `responses` | No | Direct Responses-compatible provider. |
| `mixed` | `codex-auth-compatible` | `chat-completions` | Yes | Codex++ style relay: Codex sees Responses, relay owns upstream API calls. |
| `pure-api` | `api-key-compatible` | `chat-completions` | Yes | API-key-only fallback for OpenAI-compatible providers. |

The next implementation phase is splitting the low-level adapter converter into smaller request, response, and SSE modules while preserving the current public facade.

See [docs/TARGET.md](docs/TARGET.md) for the locked target and phased migration plan.

See [docs/CODEX_PLUS_PLUS_CONVERSION_PORTING.md](docs/CODEX_PLUS_PLUS_CONVERSION_PORTING.md) for the detailed Codex++ protocol conversion porting checklist.

See [docs/OPENAI_BUILTIN_TOOL_COMPATIBILITY.md](docs/OPENAI_BUILTIN_TOOL_COMPATIBILITY.md) for hosted tool parity status.

See [docs/RECIPES.md](docs/RECIPES.md) and [examples](examples) for host-neutral integration examples.

See [docs/INDEPENDENT_PACKAGE_CHECKLIST.md](docs/INDEPENDENT_PACKAGE_CHECKLIST.md) for the remaining package readiness gates before `private: true` can be removed.

See [docs/LIVE_SMOKE_RECIPES.md](docs/LIVE_SMOKE_RECIPES.md), [docs/UNSAFE_TOOL_SECURITY.md](docs/UNSAFE_TOOL_SECURITY.md), and [docs/RELEASE_READINESS.md](docs/RELEASE_READINESS.md) for release-readiness validation.
