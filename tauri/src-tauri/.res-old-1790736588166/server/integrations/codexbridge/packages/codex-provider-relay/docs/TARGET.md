# Codex Provider Relay Target

## Immutable Target

Let non-OpenAI models participate in the Codex native tool-call loop.

This target is intentionally narrower than "support more providers" and broader than "proxy chat completions":

- Codex app-server must still own thread orchestration, approvals, local tools, workspace mutations, and continuation.
- The relay must preserve the Responses API shape Codex expects.
- The relay must translate provider tool calls back into Codex-compatible Responses events.
- The relay must make hosted-tool gaps explicit instead of silently dropping capabilities.

## Architecture Boundary

```text
Host app UI (CodexBridge / CodexNext / future app-server)
  -> codex-provider-relay package
     -> provider config/profile builder
     -> protocol conversion
     -> local Responses adapter server
     -> upstream provider client
  -> Codex app-server
```

`codex-provider-relay` is the integration SDK and owns provider config/profile generation, protocol conversion, provider capability policy, and the local Responses adapter server. It must not depend on host-app platform adapters, Web UI components, session stores, or provider-specific UI state.

`codex-native-api` remains separate. It exposes logged-in Codex runtime behavior as an API facade; it is not the provider relay.

## Required Modes

### Official

Use this when the upstream already speaks a Codex-compatible Responses API. Codex points directly at the upstream `base_url`, and no local Responses adapter is required.

Profile defaults:

- `mode = "official"`
- `relayProtocol = "responses"`
- `authMode = "codex-auth-compatible"`
- `needsLocalResponsesAdapter = false`

### Codex Auth Compatible

The mixed profile supports the Codex++-style provider configuration:

```toml
model_provider = "custom"
model = "gpt-5.4"

[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "http://127.0.0.1:57321/v1"
experimental_bearer_token = "sk-..."
supports_websockets = false
```

This mode is the canonical path for preserving Codex-native behavior while redirecting model requests.

Profile defaults:

- `mode = "mixed"`
- `relayProtocol = "chat-completions"`
- `authMode = "codex-auth-compatible"`
- `needsLocalResponsesAdapter = true`

### API Key Compatible

The pure API profile keeps the existing OpenAI-compatible fallback:

```toml
requires_openai_auth = false
env_key = "OPENAI_API_KEY"
```

This mode is useful for compatibility, but it is not the long-term default for full Codex tool-loop parity.

Profile defaults:

- `mode = "pure-api"`
- `relayProtocol = "chat-completions"`
- `authMode = "api-key-compatible"`
- `needsLocalResponsesAdapter = true`

## Tool Strategy Contract

### `codex-local-first`

Default. Codex remains the executor for local tools and approvals. The relay translates tool declarations and tool-call events so non-OpenAI models can request Codex tools.

### `provider-native`

Only for upstream providers that truly support a hosted tool capability. The relay may forward provider-native tool options when declared in provider capabilities.

Profiles using this strategy must declare each hosted tool, for example `web_search -> web_search_preview`.

### `relay-emulated`

For capabilities such as web search or file search when the upstream provider does not natively support them. The relay or an attached MCP/search/file service must execute the tool and feed results back into the model loop.

Profiles using this strategy must declare each relay-owned hosted tool, for example `file_search -> mcp_file_search`.

Current package support:

- `web_search` can be declared as `relay-emulated` and backed by a host-provided executor registry.
- The SDK includes fetch-based `web_search` executor factories for Tavily, Brave Search, and Serper; hosts pass keys at runtime.
- `file_search` can be declared as `relay-emulated` and backed by the same executor registry.
- The SDK includes a generic `file_search` executor with a pluggable `sources` contract. `roots` remains a local-filesystem shortcut, and the local source does not scan cwd implicitly, skips common dependency/build/binary paths by default, rejects unsafe `path_glob` traversal, and bounds scanned files, file bytes, payload bytes, OpenAI-compatible chunk content, and results.
- The SDK includes a memory-documents `file_search` source so hosts can expose in-memory summaries, notes, and session records without coupling this package to CodexBridge or CodexNext storage.
- The SDK includes a SQLite FTS `file_search` source that generates sanitized FTS SQL and runs through a host-injected `database.all(sql, params)` or custom query function. This keeps persistent search support reusable without adding a sqlite driver dependency to the relay package.
- The SDK includes a generic embedding provider contract, a generic OpenAI-compatible embeddings API provider, a thin OpenRouter/Qwen default wrapper, an in-memory vector `file_search` source, and a local-vector file source with chunking plus pluggable memory and SQLite `CodexProviderRelayLocalVectorIndexStore` implementations. This validates the project-file semantic-search surface before adding Qdrant, LanceDB, pgvector, or remote-doc backends.
- Non-streaming Chat Completions loops are executed inside the relay: upstream tool call -> relay executor -> tool output message -> follow-up upstream call -> Codex-compatible Responses result.
- Streaming Chat Completions loops are executed inside the relay: upstream streamed relay tool-call deltas are consumed internally, the executor result is appended as a tool message, and the follow-up upstream answer stream is forwarded through the existing Responses SSE translator.
- Hosted-tool execution progress can be exposed with the opt-in `emitHostedToolSseEvents` flag. The relay then emits `hosted_tool.started`, `hosted_tool.delta`, `hosted_tool.completed`, and `hosted_tool.failed` before normal Responses SSE events. This remains opt-in because these are relay-specific event names, not baseline Responses API events.

## Migration Plan

1. Establish this package with the fixed target, config builders, and public types.
2. Move Codex app-server provider config generation into this package and keep host-app adapters as consumers.
3. Wrap local Responses adapter lifecycle through this package without importing host-app adapter types.
4. Add Codex++ compatible auth mode using `requires_openai_auth = true`.
5. Add contract tests for `function_call`, `custom_tool_call`, `namespace`, `apply_patch`, `web_search`, and streaming tool deltas.
6. Switch CodexBridge provider code to consume this package through host-side adapter options.
7. Allow CodexNext to consume the same package without importing CodexBridge internals.
8. Expose high-level official/mixed/pure API profile builders so app-servers can avoid invalid auth/protocol combinations.
9. Keep `codex-gateway` only as a temporary compatibility package or historical reference; new consumers should import only `@codexbridge/codex-provider-relay`.
10. Add remaining hosted-tool executors as separate adapters, keeping each capability explicitly declared and independently testable. Local filesystem `file_search`, memory-documents `file_search`, SQLite FTS `file_search`, in-memory vector `file_search`, local-vector `file_search`, SQLite vector persistence, and the generic embedding/source/store contracts are implemented first; Qdrant/LanceDB/pgvector sources, code interpreter, image generation, and computer-use adapters remain future work.
