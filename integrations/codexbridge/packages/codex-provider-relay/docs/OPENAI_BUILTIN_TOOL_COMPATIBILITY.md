# OpenAI Built-in Tool Compatibility

This document tracks how `@codex-provider/core` maps OpenAI Responses built-in tools to package-owned behavior.

Historical names under `@codexbridge/codex-provider-relay` and `CodexProviderRelay*` remain as deprecated aliases during the stabilization cycle.

The package goal is not to pretend every upstream provider supports OpenAI hosted tools. It must make each tool mode explicit:

- `provider-native`: forward the OpenAI tool only when the upstream actually supports the same hosted tool semantics.
- `relay-emulated`: expose a Chat function proxy, execute the matching package/host executor, append tool output, and continue the model loop.
- `codex-local-first`: leave execution to Codex app-server / Codex CLI / host-owned local tool orchestration.
- `declaration-only`: the package may recognize the tool name, but it is not executable without a future executor contract.

## Source Baseline

Official OpenAI docs checked for this matrix:

- Responses tools overview: https://platform.openai.com/docs/guides/tools?api-mode=responses
- Responses API reference: https://platform.openai.com/docs/api-reference/responses/create?api-mode=responses
- Web search: https://platform.openai.com/docs/guides/tools-web-search?api-mode=responses
- File search: https://platform.openai.com/docs/guides/tools-file-search
- Remote MCP / connectors: https://platform.openai.com/docs/guides/tools-remote-mcp
- Image generation tool: https://platform.openai.com/docs/guides/tools-image-generation
- Code interpreter tool: https://platform.openai.com/docs/guides/tools-code-interpreter
- Computer use: https://platform.openai.com/docs/guides/tools-computer-use
- Codex manual for Codex-local skills, MCP, shell, computer, and local execution surfaces.

## Compatibility Matrix

| Tool | OpenAI tool type | Current support | Relay mode | Executor required | Output parity | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Web search | `web_search` | Partial. `web_search_preview*` aliases normalize to canonical `web_search`; relay executor exists for Tavily, Brave, and Serper. | `provider-native` / `relay-emulated` | Yes for `relay-emulated` | Partial. Current output has answer/results; v2 fields and richer citations are not fully aligned. | P1 |
| File search | `file_search` | Strong v1. Local-fs, memory, sqlite-fts, in-memory-vector, local-vector, cache fingerprint, RRF, safety bounds, vector-store contract, remote-doc contract, and `include: ["file_search_call.results"]` exposure exist. | `relay-emulated` | Yes | Strong relay parity for OpenAI-like `data[]` and synthetic `file_search_call.results`; exact OpenAI-hosted retrieval annotations are not claimed. | P1 done |
| Tool search | `tool_search` as package-owned deferred discovery surface. | Partial. Registry/converter/server loop support relay-emulated `tool_search`; `createCodexProviderToolSearchExecutor()` can return deferred function tools and namespaces. | `relay-emulated` / client-deferred | Yes | Partial. Returned tools are appended to the next Chat request; no provider-native output item is synthesized. | P2 done |
| Remote MCP / connectors | `mcp` | No package executor. OpenAI-hosted Responses can use `mcp`; Codex hosts may also handle MCP locally. | `provider-native` / `codex-local-first`; future `relay-emulated` only with explicit host adapter | Yes for relay | No | P2 |
| Skills | Not an OpenAI Responses hosted tool type; Codex-local customization surface. | No package support. Should stay host/Codex-local unless modeled as deferred tool definitions later. | `codex-local-first` | No package executor by default | Not applicable | P2 |
| Image generation | `image_generation` | Partial. Registry/converter/server loop support relay-emulated `image_generation`; `createCodexProviderImageGenerationExecutor()` exposes a host-supplied provider contract. | `provider-native` / `relay-emulated` | Yes for relay | Partial. Opt-in `image_generation_call` output can be appended; no default image provider is bundled. | P3 done |
| Code interpreter | `code_interpreter` | Partial. Registry/converter/server loop support relay-emulated `code_interpreter`; `createCodexProviderCodeInterpreterExecutor()` exposes a host-supplied sandbox contract. | `provider-native` / `relay-emulated` | Yes for relay | Partial. stdout/stderr/result/files are returned as tool output; stdout/stderr can stream through hosted tool SSE deltas. No default sandbox is bundled. | P4 done |
| Computer | `computer` canonical name, with `computer_use` and `computer_use_preview` legacy aliases. | Partial. Registry/converter/server loop support relay-emulated `computer`; `createCodexProviderComputerExecutor()` exposes a host-supplied computer adapter contract. | `codex-local-first` first / `provider-native` / `relay-emulated` only with explicit executor | Yes for relay | Partial. actions/display are normalized and screenshot/observations are returned as tool output. No default computer control is bundled. | P5 done |
| Shell | Codex-local tool surface, not a general OpenAI hosted tool. Existing converter has Codex built-in context handling for `local_shell`. | Partial Codex-local conversion only. No hosted relay shell executor. | `codex-local-first`; future `relay-emulated` should remain unsafe and opt-in only | Yes for relay | Partial for Codex-local custom-tool conversion only | P5 |
| Local shell | `local_shell` in Codex-local context, not a general public OpenAI hosted tool. | Partial Codex-local conversion only. | `codex-local-first` | No package executor by default | Partial | Keep local-first |
| Apply patch | Codex custom tool `apply_patch` | Strong Codex++ proxy conversion for structured Chat tool calls and response reconstruction. | `codex-local-first` | Codex executes; package only translates/proxies | Strong for current Codex custom-tool bridge | Keep |

## Current Package Reality

Current public package surface already exports:

- `createCodexProviderWebSearchExecutor`
- `createCodexProviderFileSearchExecutor`
- `createCodexProviderToolSearchExecutor`
- `createCodexProviderCodeInterpreterExecutor`
- `createCodexProviderComputerExecutor`
- `createCodexProviderImageGenerationExecutor`
- `createCodexProviderOpenAICompatibleImageGenerationProvider`
- hosted tool declarations and executor registry
- Responses-to-Chat and Chat-to-Responses converters
- local Responses adapter server
- profile/runtime helpers

Current implementation now centralizes canonical built-in metadata in `src/builtin-tools/`, with adapter-specific wiring still present in:

- `src/hosted_tools.ts`
- `src/hosted_tool_executors.ts`
- `src/converters/responses_adapter.ts`
- `src/server/responses_adapter_server.ts`
- `src/converters/codex_tool_context.ts`

The next phase should keep moving heavy or unsafe tools behind explicit executor contracts without changing existing public behavior.

## Required Semantics

1. Hosted tools must be explicit.
   Example: `{ name: "file_search", mode: "relay-emulated" }`.

2. Relay-emulated tools must have registered executors.
   Example: `hostedToolExecutors.file_search = createCodexProviderFileSearchExecutor(...)`.

3. Provider-native tools must only be forwarded when provider capabilities explicitly say they are supported.

4. Unsafe tools remain disabled by default:
   - `computer`
   - `computer_use_preview`
   - `shell`
   - `local_shell`
   - `code_interpreter`
   - `apply_patch` execution

5. Codex-local tools remain Codex-local unless the host opts into an explicit relay executor.

## Priority Plan

### P1: Registry and alias normalization

- Done: added `src/builtin-tools/`.
- Done: defined canonical tool names.
- Done: normalized legacy aliases:
  - `web_search_preview` -> `web_search`
  - `web_search_preview_2025_03_11` -> `web_search`
  - `computer_use` -> `computer`
  - `computer_use_preview` -> `computer`
- Done: replaced distributed built-in checks with registry-backed facade functions where they affect hosted relay exposure.
- Done: preserved existing public API and tests.

### P1: File search parity hardening

- Preserve current executor output page.
- Add Responses `include: ["file_search_call.results"]` observability strategy.
- Standardize result content fields across all sources.
- Add more metadata filter parity tests.
- Add vector-store and remote-doc source contracts only; do not bind Qdrant/LanceDB/pgvector.

### P2: Web search v2

- Done: parse `search_context_size`, `user_location`, `filters`, `external_web_access`, and `return_token_budget`.
- Done: Tavily/Brave/Serper providers are source adapters under a generic web-search source contract.
- Done: preserved current output while adding optional `sources`, `citations`, `retrieved_at`, and access metadata.

### P2: Tool search / MCP / skills planning

- Done: added `createCodexProviderToolSearchExecutor()`.
- Done: relay-emulated `tool_search` can return deferred function tools/namespaces and append them to the next Chat request.
- Treat OpenAI `mcp` separately from Codex-local MCP.
- Treat Codex skills as local/deferred tool definitions, not OpenAI hosted tools.
- `tool_search` remains guarded by explicit hosted tool declaration plus registered executor.

### P3-P5: Unsafe or heavy tools

- Done for `image_generation`: executor contract and optional OpenAI-compatible image provider factory exist, but no provider is enabled by default.
- Done for `code_interpreter`: executor contract exists and supports stdout/stderr hosted tool deltas, but no sandbox is enabled by default.
- Done for `computer`: executor contract exists and supports actions/display plus screenshot/observation output, but no computer-control adapter is enabled by default.
- Do not provide default executors for unsafe or environment-controlling tools.
- Require host-owned sandbox, approval, and safety policy.

## Non-Goals For This Phase

- No external vector DB adapter implementation.
- No sqlite driver dependency.
- No Qdrant, LanceDB, pgvector, sqlite-vec dependency.
- No CodexBridge/CodexNext session or UI logic.
- No shell/computer/code execution default.
- No package publishing switch; `private: true` stays until package readiness is complete.

## Package Independence Status

- Done: formal `CodexProviderTraceEvent` and `CodexProviderTraceSink` names are exported.
- Done: formal standalone server helpers are exported:
  - `createCodexProviderStandaloneServerConfigFromEnv`
  - `createCodexProviderStandaloneServerFromEnv`
  - `loadCodexProviderStandaloneEnvFile`
  - `resolveCodexProviderStandaloneServerEnv`
- Done: deprecated `CodexGateway*` aliases remain available for old consumers.
- Done: standalone deployments can use `CODEX_PROVIDER_RELAY_*` environment variables while the env namespace remains stable.
- Done: host-neutral examples and recipes exist under `examples/` and `docs/RECIPES.md`.
- Done: live smoke recipes, unsafe tool security notes, and release-readiness policy docs exist.
- Remaining: execute live smoke runs, record redacted evidence, and finalize package naming/versioning/release workflow.
