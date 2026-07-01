# Codex++ Conversion Porting Checklist

## Purpose

This document tracks the planned port of Codex++ protocol conversion behavior into the reusable Codex provider relay.

The fixed target is unchanged:

> Let non-OpenAI models participate in the Codex native tool-call loop.

The conversion work now belongs in `packages/codex-provider-relay`. The package exposes the reusable integration surface, Codex config/profile helpers, low-level protocol conversion, capability policy, and the local Responses adapter server as a single SDK surface for CodexBridge, CodexNext, and future app-server integrations.

## Current Status Snapshot

Last updated: 2026-06-07

### Completed In This Phase

- [x] P0 Tool context model: reversible custom/function/namespace/apply-patch tool identity is implemented in `codex_tool_context.ts`.
- [x] P1 request conversion behavior: Responses requests now preserve custom tools, namespace tools, apply-patch proxies, tool history, tool choice, and stream usage options when converted to Chat Completions.
- [x] P2 non-streaming response conversion behavior: Chat responses now restore custom tool calls, namespace function calls, apply-patch proxy calls, reasoning fields, and leading inline `<think>` blocks.
- [x] P3 streaming conversion behavior: Chat SSE streams now map reasoning, text, custom tool calls, apply-patch proxy calls, inline `<think>`, upstream errors, and UTF-8 chunk boundaries into Responses-compatible SSE.
- [x] P4 apply-patch proxy: Codex freeform `apply_patch` is exposed to Chat providers as structured proxy tools and reconstructed back to Codex-compatible patch text.
- [x] P5 reasoning normalization: provider reasoning fields and explicit inline think blocks are surfaced through Responses reasoning events/items instead of leaking into answer text.
- [x] P6 SSE parser/error handling: upstream `event: error` frames and split UTF-8 chunks are covered by server tests.
- [x] P7 public facade compatibility: existing `responses_adapter.ts` exports remain stable and existing gateway contract tests pass.
- [x] P8 provider relay config generation: `codex-provider-relay` now generates protocol-aware Codex provider config and `openai_compatible` launch args reuse it.
- [x] SDK runtime wrapper: `CodexProviderRelayRuntime` owns adapter server start/stop, local Responses base URL exposure, and Codex CLI config generation. A host may inject an adapter server factory, but the default server is package-local.
- [x] HTTP relay tool-loop coverage: adapter server tests now verify custom tools, namespace/MCP tools, and `apply_patch` proxy calls over full Responses -> Chat Completions -> Responses request cycles.
- [x] Apply-patch proxy action coverage: add, delete, update, replace, batch, and invalid-JSON fallback are covered by gateway protocol tests.
- [x] Gated live smoke path: `test:live-openai-compatible` now includes a real upstream custom-tool loop smoke when provider profiles and API keys are configured.
- [x] Codex++ request-history semantics: reasoning input items, assistant/tool-call merging, orphan tool-output fallback, `latest_reminder`, late system/developer collapse, empty assistant normalization, and no-tool control filtering are covered by translated protocol tests.
- [x] Real upstream live smoke: DeepSeek, Qwen, and OpenRouter have passed normal response plus custom-tool continuation through the relay using local gitignored provider credentials; MiniMax remains skipped until a `MINIMAX_API_KEY` profile is configured.
- [x] High-level relay profile surface: `official`, `mixed`, and `pure-api` profile builders now encode the intended auth/protocol/local-adapter combinations for host apps such as CodexBridge, CodexNext, and future app-server integrations.
- [x] Hosted tool declaration contract: `provider-native` and `relay-emulated` strategies now require explicit hosted tool declarations instead of silently assuming upstream OpenAI hosted-tool parity.
- [x] Codex++ CCS request edge behavior: unsupported/default reasoning models no longer receive `reasoning_effort`, tool controls are only forwarded when Chat tools survive, o-series `max_output_tokens` maps to `max_completion_tokens`, explicit `max_tokens` / `max_completion_tokens` aliases are preserved, and array instructions collapse into system text.
- [x] Codex++ model-name reasoning dialect fallback: DeepSeek, OpenRouter, Qwen/SiliconFlow, Kimi/GLM/Moonshot, MiniMax, StepFun, gpt-5+, and o-series behavior is mirrored when no host capability override is provided.
- [x] Codex++ URL/path normalization: Chat Completions and models URL builders now handle origin-only base URLs, versioned bases, already-complete endpoint URLs, `/openai#` version-skip suffixes, and `/v1/v1` collapse; proxy route matchers accept `/v1/*`, `/v1/v1/*`, and `/codex/v1/*` aliases.
- [x] Codex++ cache usage mapping: Gemini-family `promptTokenCount` subtracts `cachedContentTokenCount` from billable input tokens, and Claude-style cache read / 5m / 1h creation token fields are preserved with `cache_ttl`.
- [x] Relay-emulated hosted tool execution foundation: package-level executor registry is implemented, `web_search` declarations can be converted into relay-owned Chat function tools, and the local adapter can execute upstream tool calls then continue the Chat Completions loop before returning a Codex-compatible Responses result.
- [x] Relay-emulated `web_search` streaming loop: streamed relay-owned tool-call deltas are consumed internally, the executor result is appended as a Chat tool message, and the follow-up upstream answer stream is forwarded through the existing Responses SSE translator.
- [x] Reusable `web_search` executor factory: Tavily, Brave Search, and Serper adapters normalize results into the relay-hosted tool output contract without storing provider secrets in the SDK.
- [x] Opt-in hosted-tool SSE observability: stream clients can enable `emitHostedToolSseEvents` to receive `hosted_tool.started`, `hosted_tool.delta`, `hosted_tool.completed`, and `hosted_tool.failed` lifecycle events without exposing internal relay tool names by default.
- [x] Relay-emulated `file_search` protocol loop: `file_search` declarations can be converted into relay-owned Chat function tools, executed through the package executor registry, and streamed through the same internal tool-call continuation path as `web_search`.
- [x] Reusable local filesystem `file_search` executor: explicit roots, default dependency/build/binary ignores, symlink opt-in, bounded scan limits, bounded file reads, OpenAI-compatible `content[]` chunks, and optional chunk content are implemented without depending on CodexBridge host state.
- [x] Generic `file_search` source contract: the executor now accepts pluggable `sources`, preserves `roots` as a local-fs shortcut, aggregates cross-source results, applies a total payload bound, and keeps source implementations independent from CodexBridge host state.
- [x] Reusable memory-documents `file_search` source: hosts can pass explicit in-memory documents with `id`, `title`, `uri`, `path`, and `content`, and the source reuses the same title/content scoring, OpenAI-compatible chunk generation, `path_glob`, and include-content behavior as the local filesystem source.
- [x] Reusable SQLite FTS `file_search` source: hosts can pass an injected `database.all(sql, params)` or custom `query()` function, while the relay package owns safe identifier validation, FTS query construction, path filtering, row normalization, OpenAI-compatible chunk generation, and include-content behavior without depending on a sqlite driver.
- [x] Embedding provider contract and semantic sources: `CodexProviderRelayEmbeddingProvider`, `createCodexProviderRelayEmbeddingsApiProvider()`, the thin `createCodexProviderRelayOpenRouterEmbeddingProvider()` convenience wrapper, `createCodexProviderRelayInMemoryVectorFileSearchSource()`, `createCodexProviderRelayLocalVectorFileSearchSource()`, `createCodexProviderRelayMemoryLocalVectorIndexStore()`, and `createCodexProviderRelaySqliteLocalVectorIndexStore()` are implemented. The local-vector source reuses explicit-root local-fs safety, chunks files, caches unchanged document embeddings by mtime/size/model, and performs hybrid vector/lexical scoring. The SQLite store persists documents/chunks/embedding vectors through host-injected `database.all/run` without adding a sqlite driver dependency. The core provider accepts a host-supplied embeddings endpoint/model/headers/API key; OpenRouter Qwen is only the default smoke-test configuration. Tests use deterministic fake embeddings and an optional env-gated real embeddings API integration test.

### Still To Do

- [ ] Split `responses_adapter.ts` into the proposed smaller modules: `responses_to_chat.ts`, `chat_to_responses.ts`, and `chat_sse_to_responses.ts`.
- [ ] Add external vector and remote-docs `file_search` source adapters, such as Qdrant, LanceDB, pgvector, and remote-doc stores, behind the existing executor contract.
- [ ] Add concrete hosted-tool adapters for code interpreter, image generation, and computer-use as separate opt-ins.

## Source Baseline

- Source repository: `/home/ubuntu/dev/reference/BigPizzaV3-CodexPlusPlus`
- Source commit inspected: `1df4152`
- Source license marker: `/home/ubuntu/dev/reference/BigPizzaV3-CodexPlusPlus/Cargo.toml:13`, `license = "MIT"`
- Main source file: `/home/ubuntu/dev/reference/BigPizzaV3-CodexPlusPlus/crates/codex-plus-core/src/protocol_proxy.rs`
- Main source tests: `/home/ubuntu/dev/reference/BigPizzaV3-CodexPlusPlus/crates/codex-plus-core/tests/protocol_proxy.rs`

If code is directly translated from Codex++, keep a source note in the target module header or test file header with the source commit and source path.

## Target Module Layout

Proposed target files:

- `packages/codex-provider-relay/src/converters/codex_tool_context.ts`
- `packages/codex-provider-relay/src/converters/apply_patch_proxy.ts`
- `packages/codex-provider-relay/src/converters/responses_to_chat.ts`
- `packages/codex-provider-relay/src/converters/chat_to_responses.ts`
- `packages/codex-provider-relay/src/converters/chat_sse_to_responses.ts`
- `packages/codex-provider-relay/src/converters/responses_adapter.ts`
- `packages/codex-provider-relay/test/codex_plus_plus_protocol.test.ts`

`responses_adapter.ts` should become a compatibility facade that preserves the current public exports while delegating to the smaller modules.

## Migration Order

### P0. Tool Context Model

Status: Implemented in `packages/codex-provider-relay/src/converters/codex_tool_context.ts`

Source:

- `protocol_proxy.rs:43` `CodexToolContext`
- `protocol_proxy.rs:51` `CodexCustomToolSpec`
- `protocol_proxy.rs:58` `CodexFunctionToolSpec`
- `protocol_proxy.rs:64` `CodexCustomToolKind`
- `protocol_proxy.rs:77` `CodexPatchProxyAction`
- `protocol_proxy.rs:98` helper methods
- `protocol_proxy.rs:1936` `build_codex_tool_context`

Target:

- `packages/codex-provider-relay/src/converters/codex_tool_context.ts`

Port:

- Represent custom tools, function tools, namespace tools, built-in tools, and apply-patch proxy tools.
- Track original Codex tool names and upstream Chat tool names.
- Add `isCustomToolProxy(upstreamName)`.
- Add `originalCustomToolName(upstreamName)`.
- Add `openaiNameForFunctionTool(upstreamName)`.
- Add `buildCodexToolContext(request.tools)`.

Important behavior:

- String tool names can be custom tool proxy names.
- `apply_patch_add_file`, `apply_patch_delete_file`, `apply_patch_update_file`, `apply_patch_replace_file`, and `apply_patch_batch` must map back to original `apply_patch`.
- `namespace` tools must preserve namespace metadata and flatten child function names only for upstream compatibility.
- `web_search`, `local_shell`, and `computer_use` should be represented as built-in/custom proxy candidates, not silently dropped.

Tests to port:

- `protocol_proxy.rs:409` namespace and custom tool conversion.
- `protocol_proxy.rs:841` custom and namespace calls with request context.
- `protocol_proxy.rs:936` string apply-patch proxy tools remap to `apply_patch`.

Done when:

- Gateway can construct a reversible tool context from a Codex Responses request.
- Existing long-name shortening still works, but namespace/custom-tool identity is no longer lost.

### P1. Responses Request To Chat Completions

Status: Behavior implemented in `packages/codex-provider-relay/src/converters/responses_adapter.ts`; follow-up module split still pending.

Source:

- `protocol_proxy.rs:127` `responses_to_chat_completions`
- `protocol_proxy.rs:1936` `build_codex_tool_context`
- `protocol_proxy.rs:2091` `responses_tools_to_chat_tools`
- `protocol_proxy.rs:2150` `responses_function_tool_to_chat_tool`
- `protocol_proxy.rs:2185` `namespace_tool_to_chat_tools`
- `protocol_proxy.rs:2240` `normalize_chat_tool_parameters`

Current target:

- `packages/codex-provider-relay/src/converters/responses_adapter.ts:76` `responsesRequestToChatCompletions`

Future target:

- `packages/codex-provider-relay/src/converters/responses_to_chat.ts`

Port:

- Keep current request conversion API.
- Replace current simple `function`-only tool conversion with Codex++ style conversion.
- Convert Codex `custom` tools into Chat function proxy tools.
- Convert `apply_patch` into five structured proxy tools.
- Convert namespace child functions into flat upstream function names while preserving reverse mapping.
- Preserve `tool_choice`, including custom `apply_patch` choices.
- Preserve `parallel_tool_calls` where the provider supports it.
- Preserve stream usage option behavior.

Important behavior:

- Do not drop Codex tools only because the upstream is Chat Completions.
- Do not pretend provider-hosted tools exist. Keep Codex as executor and expose proxy tools to the model.
- Provider capability filters may still remove unsupported fields, but tool dropping must be explicit and traceable.

Tests to port:

- `protocol_proxy.rs:409` request maps custom and namespace tools.
- `protocol_proxy.rs:472` stream includes usage and apply-patch proxy tools.
- `protocol_proxy.rs:518` custom tool call history converts to Chat tool call messages.
- `protocol_proxy.rs:577` namespace function history is flattened and invalid tool items are skipped.
- `protocol_proxy.rs:616` reasoning before tool output is preserved safely.
- `protocol_proxy.rs:652` apply-patch custom history is replayed as proxy tool.

Done when:

- A Codex Responses request with `tools: [{ type: "custom", name: "apply_patch" }]` forwards five Chat function proxy tools.
- Chat history for prior custom tool calls round-trips without losing call IDs.
- Namespace tool names are valid upstream Chat function names and can be restored later.

### P2. Non-Streaming Chat Response To Responses

Status: Behavior implemented in `packages/codex-provider-relay/src/converters/responses_adapter.ts`; follow-up module split still pending.

Source:

- `protocol_proxy.rs:214` `chat_completion_to_response`
- `protocol_proxy.rs:244` reasoning output item mapping
- `protocol_proxy.rs:250` tool call output item mapping
- `protocol_proxy.rs:2685` `tool_call_added_item`
- `protocol_proxy.rs:2782` `tool_call_done_item`
- `protocol_proxy.rs:2786` `response_tool_call_item`
- `protocol_proxy.rs:2817` inline think split helpers

Current target:

- `packages/codex-provider-relay/src/converters/responses_adapter.ts:174` `chatCompletionsResponseToResponses`

Future target:

- `packages/codex-provider-relay/src/converters/chat_to_responses.ts`

Port:

- Rebuild Responses `output` items from Chat choices.
- Map provider reasoning fields into Responses reasoning items.
- Split leading inline `<think>...</think>` blocks into reasoning plus assistant text.
- Restore shortened tool names and namespace function names.
- Reconstruct `custom_tool_call` from proxy function calls.
- Reconstruct apply-patch proxy calls back into original freeform patch input.

Important behavior:

- `apply_patch_add_file` and related proxy names must produce `type: "custom_tool_call", name: "apply_patch"`.
- Function calls under a namespace must restore `namespace`.
- Provider reasoning details should be exposed as Responses reasoning content when available.

Tests to port:

- `protocol_proxy.rs:728` reasoning, tool calls, and usage details.
- `protocol_proxy.rs:782` reasoning details extraction.
- `protocol_proxy.rs:841` custom and namespace calls with request context.
- `protocol_proxy.rs:899` apply-patch proxy call reconstruction.
- `protocol_proxy.rs:936` string apply-patch proxy tools remap.
- `protocol_proxy.rs:1015` inline `<think>` block splits into reasoning and text.

Done when:

- Non-streaming provider tool calls are indistinguishable from Codex-native Responses tool calls to the app-server.
- Assistant text does not contain raw leading `<think>` blocks after conversion.

### P3. Streaming Chat SSE To Responses SSE

Status: Behavior implemented for custom/apply-patch tool-call reconstruction, reasoning streams, upstream errors, UTF-8 chunking, and inline `<think>` handling in `packages/codex-provider-relay/src/converters/responses_adapter.ts`; follow-up module split still pending.

Source:

- `protocol_proxy.rs:296` `ChatSseToResponsesConverter`
- `protocol_proxy.rs:322` UTF-8-safe incremental push
- `protocol_proxy.rs:358` SSE block parsing
- `protocol_proxy.rs:712` `ChatSseState`
- `protocol_proxy.rs:762` `handle_chat_chunk_into`
- `protocol_proxy.rs:813` inline think streaming logic
- `protocol_proxy.rs:890` response start events
- `protocol_proxy.rs:913` reasoning delta events
- `protocol_proxy.rs:964` text delta events
- `protocol_proxy.rs:1014` tool call delta events
- `protocol_proxy.rs:1108` final response completion
- `protocol_proxy.rs:1136` reasoning finalization
- `protocol_proxy.rs:1209` tool call finalization
- `protocol_proxy.rs:2685` tool added/done item helpers
- `protocol_proxy.rs:2723` tool delta SSE
- `protocol_proxy.rs:2746` tool done SSE

Current target:

- `packages/codex-provider-relay/src/converters/responses_adapter.ts:316` `translateChatCompletionsSseStreamToResponsesSse`
- `packages/codex-provider-relay/src/converters/responses_adapter.ts:740` stream chunk handling

Future target:

- `packages/codex-provider-relay/src/converters/chat_sse_to_responses.ts`

Port:

- Keep current async generator API.
- Add a Codex++ style stream state that has tool context from the original request.
- Parse Chat SSE incrementally and UTF-8 safely.
- Convert reasoning deltas into Responses reasoning events.
- Convert assistant content deltas into Responses text events.
- Convert function tool call deltas into Responses function call events.
- Convert custom tool proxy deltas into `custom_tool_call_input` events.
- Finalize open reasoning/message/tool items in deterministic output order.
- Emit failed Responses events on upstream stream errors.

Important behavior:

- For custom tools, argument deltas should not leak as `function_call_arguments.delta`; final reconstructed input should appear as `response.custom_tool_call_input.delta` / done path.
- Tool deltas may arrive before full function name or full arguments. State must tolerate partial chunks.
- Inline `<think>` content can span multiple chunks and must not leak into final text.

Tests to port:

- `protocol_proxy.rs:1061` reasoning, inline think, tools, and errors.
- `protocol_proxy.rs:1121` custom tool call with request context.
- `protocol_proxy.rs:1161` UTF-8 safe chunk boundaries.
- Existing `packages/codex-provider-relay/test/contracts.test.ts:199` streaming text and tool-call chunks.

Done when:

- A streaming third-party model can request Codex tools and Codex app-server receives valid Responses SSE events.
- Reasoning, text, tool calls, and final completion all stream as separate events.

### P4. Apply Patch Proxy

Status: Implemented in `packages/codex-provider-relay/src/converters/apply_patch_proxy.ts`

Source:

- `protocol_proxy.rs:77` `CodexPatchProxyAction`
- `protocol_proxy.rs:1936` apply-patch context entries
- `protocol_proxy.rs:2091` apply-patch proxy tool conversion
- `protocol_proxy.rs:3096` `build_custom_tool_call_history`
- `protocol_proxy.rs:3119` `reconstruct_custom_tool_call_input_with_context`
- `protocol_proxy.rs:3132` `reconstruct_custom_tool_call_input`
- `protocol_proxy.rs:3142` `reconstruct_apply_patch_input`
- `protocol_proxy.rs:3187` `build_apply_patch_text`

Target:

- `packages/codex-provider-relay/src/converters/apply_patch_proxy.ts`

Port:

- Define patch proxy actions:
- `add_file`
- `delete_file`
- `update_file`
- `replace_file`
- `batch`
- Convert original Codex freeform apply_patch text into structured Chat function arguments when replaying history.
- Reconstruct structured Chat function arguments into valid apply_patch text when the model calls a proxy tool.
- Preserve raw patch input as fallback.

Important behavior:

- Use structured proxy tools because many non-OpenAI models are better at JSON tool calls than freeform patch grammar.
- Always reconstruct to original Codex-compatible patch text before sending the tool call back to Codex.
- Invalid JSON arguments should fall back to raw argument text instead of crashing the stream.

Tests to port:

- `protocol_proxy.rs:472` apply-patch proxy tool declaration.
- `protocol_proxy.rs:652` apply-patch custom history replay.
- `protocol_proxy.rs:899` add-file reconstruction.
- Add local tests for delete, update, replace, batch, invalid JSON fallback.

Done when:

- The model can call `apply_patch_add_file` and Codex receives a `custom_tool_call` named `apply_patch` with `*** Begin Patch` text.

### P5. Reasoning And Thinking Normalization

Status: Implemented for `reasoning_content`, `reasoning_details`, non-streaming inline `<think>`, and streaming inline `<think>` in `packages/codex-provider-relay/src/converters/responses_adapter.ts`

Source:

- `protocol_proxy.rs:32` `ChatReasoningStyle`
- `protocol_proxy.rs:178` reasoning request options
- `protocol_proxy.rs:1368` `chat_delta_reasoning_text`
- `protocol_proxy.rs:1378` inline think prefix detection
- `protocol_proxy.rs:2817` leading think block split

Current target:

- `packages/codex-provider-relay/src/capabilities/thinking_policy.ts`
- `packages/codex-provider-relay/src/converters/responses_adapter.ts`

Future target:

- `packages/codex-provider-relay/src/converters/chat_to_responses.ts`
- `packages/codex-provider-relay/src/converters/chat_sse_to_responses.ts`

Port:

- Keep current provider capability policy.
- Add Codex++ response-side extraction for provider-specific reasoning fields.
- Add inline `<think>` split for non-streaming.
- Add streaming inline `<think>` detector.

Important behavior:

- Reasoning should be shown as Responses reasoning items, not mixed into assistant answer text.
- If provider sends no reasoning field and no `<think>` block, do nothing.
- Do not expose hidden chain-of-thought beyond what upstream explicitly emits as text or reasoning summary.

Tests to port:

- `protocol_proxy.rs:728` reasoning output item.
- `protocol_proxy.rs:782` reasoning details.
- `protocol_proxy.rs:1015` non-streaming inline think split.
- `protocol_proxy.rs:1061` streaming inline think split.

Done when:

- DeepSeek-style `reasoning_content` and MiniMax-style `<think>` output both appear in the Responses reasoning channel.

### P6. SSE Parser And Error Handling

Status: Implemented for current server architecture in `packages/codex-provider-relay/src/server/responses_adapter_server.ts`

Source:

- `protocol_proxy.rs:296` converter buffer fields
- `protocol_proxy.rs:322` `push_bytes`
- `protocol_proxy.rs:337` `finish`
- `protocol_proxy.rs:351` `fail`
- `protocol_proxy.rs:358` `handle_block`
- `protocol_proxy.rs:379` malformed JSON skip behavior
- `protocol_proxy.rs:382` upstream error event mapping

Current target:

- `packages/codex-provider-relay/src/server/responses_adapter_server.ts:771` `readSseDataLines`
- `packages/codex-provider-relay/src/converters/responses_adapter.ts:316` streaming generator

Future target:

- `packages/codex-provider-relay/src/converters/chat_sse_to_responses.ts`

Port:

- Decide whether to keep server-level SSE parsing or move full parsing into converter.
- Add explicit tests for split UTF-8 bytes.
- Add explicit tests for SSE `event: error`.
- Add explicit tests for JSON payload with `error`.
- Keep current generator API stable for server code.

Important behavior:

- Partial UTF-8 should not corrupt Chinese text or emoji.
- `[DONE]` should finalize exactly once.
- Stream failure should emit a Responses failure event before final `[DONE]`.

Tests to port:

- `protocol_proxy.rs:1061` error stream behavior.
- `protocol_proxy.rs:1161` split UTF-8 behavior.
- Existing gateway stream failure tests around `contracts.test.ts`.

Done when:

- Streaming conversion is stable under chunk boundaries, upstream errors, and malformed non-terminal SSE blocks.

### P7. Public Adapter Facade Compatibility

Status: Implemented for the current compatibility facade in `packages/codex-provider-relay/src/converters/responses_adapter.ts`

Source:

- Current public functions in `packages/codex-provider-relay/src/converters/responses_adapter.ts`

Target:

- `packages/codex-provider-relay/src/converters/responses_adapter.ts`
- `packages/codex-provider-relay/src/index.ts`

Port:

- Preserve existing exports:
- `responsesRequestToChatCompletions`
- `chatCompletionsResponseToResponses`
- `translateChatCompletionsSseStreamToResponsesSse`
- Any existing contract helper exports used by tests/server.
- Re-export or delegate to new focused modules.

Important behavior:

- No external import path should break during this refactor.
- Server code should not need broad changes in the first conversion pass.

Tests:

- Existing `packages/codex-provider-relay/test/public_surface.test.ts`
- Existing `packages/codex-provider-relay/test/contracts.test.ts`
- Existing `packages/codex-provider-relay/test/server.test.ts`

Done when:

- All existing gateway tests pass without consumers changing import paths.

### P8. Provider Relay Config Integration

Status: Implemented for reusable config generation in `packages/codex-provider-relay/src/codex_config.ts` and adopted by `src/providers/openai_compatible/plugin.ts`; live `~/.codex` mutation remains intentionally out of scope.

Source:

- `relay_config.rs:356` `apply_relay_profile_to_home_with_switch_rules`
- `relay_config.rs:510` `codex_base_url_for_protocol`
- `relay_config.rs:1502` `complete_relay_profile_config`
- `relay_config.rs:1647` `experimental_bearer_token_from_config`

Current target:

- `packages/codex-provider-relay/src/codex_config.ts`
- `packages/codex-provider-relay/src/runtime.ts`
- `src/providers/openai_compatible/plugin.ts`

Future target:

- `packages/codex-provider-relay/src/codex_config.ts`
- `packages/codex-provider-relay/src/profile.ts`

Port:

- Keep provider relay responsible for Codex app-server config shape.
- Add official/mixed/pure API mode semantics only after conversion tests pass.
- Generate `requires_openai_auth = true` and `experimental_bearer_token` for Codex++ style mode.
- Use local gateway base URL when upstream protocol is Chat Completions.
- Keep API-key fallback mode for current compatibility.

Implemented:

- Added `CodexProviderRelayProtocol` with `responses` and `chat-completions`.
- Added `DEFAULT_CODEX_PROVIDER_RELAY_PROTOCOL_PROXY_PORT = 57321`.
- Added `localResponsesProxyBaseUrl()`.
- Added `codexBaseUrlForRelayProtocol()`.
- `buildCodexProviderRelayConfig()` now returns both `upstreamBaseUrl` and `codexBaseUrl`.
- `chat-completions` upstreams write `model_providers.<provider>.base_url` as the local Responses proxy URL, not the third-party upstream URL.
- `buildOpenAICompatibleCodexCliArgs()` now delegates Codex `-c` argument generation to `buildCodexProviderRelayCliArgs()` while preserving its existing `api-key-compatible` fallback mode.
- Added `CodexProviderRelayRuntime` to start/stop an injected local Responses adapter server and return `adapterBaseUrl`, `codexBaseUrl`, `codexCliArgs`, and `codexConfig`.
- `src/providers/openai_compatible/plugin.ts` now uses `CodexProviderRelayRuntime` for the default Codex client startup path instead of owning adapter lifecycle directly.

Important behavior:

- Do not let config migration block protocol conversion work.
- Do not write live `~/.codex/config.toml` from this package until a caller explicitly requests it.

Tests:

- Existing `packages/codex-provider-relay/test/codex_config.test.ts`.
- Added coverage for Chat Completions upstream routing through the local Responses proxy.
- Added coverage for default proxy port and invalid port validation.
- Existing `test/providers/openai_compatible/plugin.test.ts` confirms the CodexBridge host adapter still points Codex at the local Responses adapter.
- Added `packages/codex-provider-relay/test/runtime.test.ts` for runtime start/stop, idempotent start, auth mode config, and input validation.

Done when:

- Host apps can launch Codex app-server against the local relay using Codex++ compatible config semantics.

## Test Migration Checklist

Create `packages/codex-provider-relay/test/codex_plus_plus_protocol.test.ts` and port behavior in this order:

- [x] Request converts namespace and custom tools.
- [x] Request converts apply-patch into proxy tools.
- [x] Request replays prior custom tool call history.
- [x] Request replays prior namespace tool history.
- [x] Request replays prior apply-patch history.
- [x] Non-streaming response maps reasoning content.
- [x] Non-streaming response maps namespace function calls.
- [x] Non-streaming response maps custom tool calls.
- [x] Non-streaming response reconstructs apply-patch proxy calls.
- [x] Non-streaming response splits leading `<think>` block.
- [x] Streaming response emits reasoning deltas.
- [x] Streaming response splits inline `<think>` across chunks.
- [x] Streaming response emits normal function call deltas.
- [x] Streaming response emits custom tool call input for custom proxies.
- [x] Streaming response reconstructs apply-patch proxy call input.
- [x] Streaming parser handles split UTF-8.
- [x] Streaming parser handles upstream error events.
- [x] Existing gateway contract tests still pass.
- [x] HTTP adapter loop returns provider custom tool calls as Codex `custom_tool_call` and replays `custom_tool_call_output` back to Chat tool messages.
- [x] HTTP adapter loop returns provider namespace calls as Codex `function_call` with `namespace`.
- [x] HTTP adapter loop returns provider `apply_patch_*` proxy calls as Codex freeform `apply_patch` custom calls and replays patch history back to structured Chat tool calls.
- [x] Apply-patch proxy conversion covers add, delete, update, replace, batch, and invalid JSON fallback.
- [x] Live smoke test file includes a forced `relay_echo` custom tool call and follow-up tool-output round trip.
- [x] Live smoke has been executed successfully against real upstreams in this environment: DeepSeek, Qwen, and OpenRouter normal response plus custom-tool continuation pass; MiniMax remains skipped until `MINIMAX_API_KEY` is configured.

## Acceptance Criteria For The Whole Port

- `npm run codex-provider-relay:test` passes.
- `npm run codex-provider-relay:typecheck` passes.
- A Chat Completions-only upstream can receive Codex tool declarations and return tool calls.
- Codex app-server receives valid Responses events for normal text, reasoning, function tools, custom tools, namespace tools, and apply-patch.
- No host-app Web UI, session store, Telegram, WeChat, or platform adapter logic is introduced into `codex-provider-relay`.
- No provider is silently marked as supporting hosted OpenAI tools unless capabilities explicitly say so.

## Do Not Port

- Tauri manager UI code.
- Desktop launcher code except as architectural reference.
- Provider sync as part of this conversion phase.
- CCS import as part of this conversion phase.
- Any live mutation of a user's `~/.codex` files from low-level converter modules.

## Recommended First Implementation Step

Start with P0 and P4 together:

1. Add `codex_tool_context.ts`.
2. Add `apply_patch_proxy.ts`.
3. Add request conversion tests for apply-patch proxy tools.
4. Wire only enough into `responses_adapter.ts` to pass the new tests.

This creates the reversible identity map needed by every later conversion step. Without it, streaming and non-streaming tool calls cannot be reliably reconstructed.
