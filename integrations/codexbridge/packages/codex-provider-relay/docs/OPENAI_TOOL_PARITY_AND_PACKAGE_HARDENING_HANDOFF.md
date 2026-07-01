# Codex Provider Relay：OpenAI Built-in Tool Parity & Package Hardening Handoff

## 目标

把 `packages/codex-provider-relay` 推进到“可独立成包”的下一阶段。

最终目标：

```text
Codex app-server / CodexBridge / CodexNext / 任意宿主应用
      ↓
@codexbridge/codex-provider-relay
      ↓
OpenAI-compatible Responses surface
      ↓
非 OpenAI Chat Completions / OpenAI-compatible upstream
      ↓
DeepSeek / Qwen / OpenRouter / MiniMax / Claude-compatible relay / 其他厂商
```

这个包要让其他厂商模型也能在 Codex 的原生工具调用闭环里工作。  
不要把 CodexBridge / CodexNext 的 session、UI、平台适配器、业务状态放进这个包。

## 当前状态判断

当前 `file_search` 不是从零开始，已经完成了 relay-emulated v1 的大部分核心：

- `file-search` 子模块已经拆出：
  - `types.ts`
  - `executor.ts`
  - `embeddings.ts`
  - `stores.ts`
  - `shared.ts`
  - `sources/local-fs.ts`
  - `sources/local-vector.ts`
  - `sources/local-shared.ts`
  - `sources/memory.ts`
  - `sources/sqlite-fts.ts`
  - `sources/in-memory-vector.ts`
  - `local-vector-index.ts`

- 已有能力：
  - local-fs file search
  - memory-documents source
  - sqlite-fts source
  - in-memory-vector source
  - local-vector source
  - local vector index orchestrator
  - memory local vector index store
  - sqlite local vector index store
  - sha256 content hash
  - cache fingerprint
  - chunking config hash
  - embedding dimension validation
  - stale document cleanup
  - weighted hybrid search
  - RRF ranker
  - `searchChunks?` extension point
  - tests for local-vector cache, dimensions, symlink, large file, stale deletion, sqlite persistence

所以不要重写 file_search。  
下一步是“补齐 OpenAI tool compatibility + 独立包工程化”，不是重新做本地向量索引。

## 非目标

本轮不要做：

- 不要迁移 CodexBridge / CodexNext 业务状态进包
- 不要默认接 Qdrant / LanceDB / pgvector
- 不要默认引入 sqlite driver
- 不要默认执行危险 shell / computer / code interpreter 行为
- 不要破坏现有 public API
- 不要删除旧 gateway alias；可以新增新命名并 deprecate 旧命名
- 不要把所有 provider 都假装支持 OpenAI hosted tools

## 关键约束

1. 所有 hosted tool 都必须显式声明：

```ts
hostedTools: [
  { name: "file_search", mode: "relay-emulated" }
]
```

2. relay-emulated tool 只有注册 executor 才能执行：

```ts
hostedToolExecutors: {
  file_search: createCodexProviderRelayFileSearchExecutor(...)
}
```

3. provider-native 只用于真正支持对应工具的 upstream。

4. 安全敏感工具必须默认不可用：
   - `computer`
   - `code_interpreter`
   - `shell`
   - `local_shell`
   - `apply_patch`

5. 内置工具兼容应按 OpenAI Responses API 的 tool shape 设计，但 relay 内部可用 Chat function proxy 执行。

## OpenAI built-in tool surface baseline

执行前请先核对 OpenAI 最新文档，至少覆盖这些工具：

- `web_search`
- `file_search`
- `tool_search`
- remote MCP / connectors
- skills
- shell / local shell
- computer
- apply_patch
- image_generation
- code_interpreter

注意：

- 新的 Responses API 推荐 `web_search`，不是 `web_search_preview`。
- `web_search_preview` 只能作为 legacy alias。
- `file_search` 常见字段包括 `vector_store_ids`、`max_num_results`、`filters`。
- `file_search_call.results` 是 OpenAI include 语义的一部分，当前 relay 还没有完全对齐。
- `computer` 是新的 GA 工具名，`computer_use_preview` 是旧 preview 迁移对象。
- `image_generation` 输出通常是 `image_generation_call`。
- `code_interpreter` 有 container 概念。
- `tool_search` 用于延迟加载工具定义。

## 阶段计划

---

# Phase 0：先建立 OpenAI Built-in Tool Compatibility Matrix

新增文档：

```text
packages/codex-provider-relay/docs/OPENAI_BUILTIN_TOOL_COMPATIBILITY.md
```

内容包含矩阵：

| Tool | OpenAI tool type | Current support | Relay mode | Executor required | Output parity | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Web search | `web_search` | partial | provider-native / relay-emulated | yes for relay | partial | P1 |
| File search | `file_search` | strong v1 | relay-emulated | yes | partial | P1 |
| Tool search | `tool_search` | no | relay-emulated/client | yes | no | P2 |
| Image generation | `image_generation` | declaration only | relay-emulated/provider-native | yes | no | P3 |
| Code interpreter | `code_interpreter` | declaration only | relay-emulated/provider-native | yes | no | P4 |
| Computer | `computer` | declaration alias missing | relay-emulated/provider-native | yes | no | P5 |
| Shell | `shell` / `local_shell` | Codex local-first only | codex-local-first/relay-emulated | yes | partial | P5 |
| Apply patch | `apply_patch` | Codex custom proxy supported | codex-local-first | Codex executes | strong | keep |

完成标准：

- 文档明确“哪些已经完成、哪些只是 declaration、哪些是 future work”。
- 不夸大支持范围。
- 文档写明 `provider-native` 和 `relay-emulated` 的区别。

---

# Phase 1：建立统一 Built-in Tool Registry

新增目录：

```text
packages/codex-provider-relay/src/builtin-tools/
```

建议文件：

```text
builtin-tools/types.ts
builtin-tools/catalog.ts
builtin-tools/schemas.ts
builtin-tools/normalize.ts
builtin-tools/index.ts
```

## 任务

### 1.1 定义 canonical tool names

建议类型：

```ts
export type CodexProviderRelayBuiltinToolName =
  | "web_search"
  | "file_search"
  | "tool_search"
  | "mcp"
  | "skill"
  | "shell"
  | "local_shell"
  | "computer"
  | "code_interpreter"
  | "image_generation"
  | "apply_patch";
```

### 1.2 定义 legacy aliases

至少支持：

```ts
web_search_preview -> web_search
web_search_preview_2025_03_11 -> web_search
computer_use -> computer
computer_use_preview -> computer
local_shell -> shell or local_shell, 需要保留 Codex 语义
```

### 1.3 定义 tool capability

```ts
export interface CodexProviderRelayBuiltinToolDefinition {
  name: CodexProviderRelayBuiltinToolName;
  openaiToolTypes: string[];
  relayEmulatedSupported: boolean;
  providerNativeSupported: boolean;
  requiresExecutor: boolean;
  unsafeByDefault: boolean;
  defaultRelayToolName: string;
  parameters: JsonRecord;
}
```

### 1.4 替换 converter 内部分散判断

当前 `responses_adapter.ts` 里有：

- `isBuiltinToolType`
- `isRelayHostedBuiltinToolType`
- `normalizeRelayHostedToolBuiltinType`
- `relayHostedToolParameters`
- `defaultRelayHostedToolDescription`

把这些逐步改为使用 registry。  
先保留 facade 函数，内部调用 registry，减少大改。

## 完成标准

- 现有 web_search / file_search 测试不变。
- 新增 alias 测试：
  - `web_search_preview` normalizes to `web_search`
  - `computer_use_preview` normalizes to `computer`
  - unknown builtin 不会被 silently accepted
- `hosted_tools.ts` 类型扩展到 canonical tool names，但保持旧名兼容。

---

# Phase 2：File Search OpenAI Parity Hardening

当前 `file_search` 的本地能力已经很强，但与 OpenAI Responses API 仍有差距。重点补“协议输出”和“include 语义”。

## 任务

### 2.1 支持 OpenAI-style include

OpenAI 使用：

```ts
include: ["file_search_call.results"]
```

当前 relay 主要通过 tool output 把结果给模型，不一定在最终 Responses output 中暴露 `file_search_call.results`。

要求：

- 在 `OpenAICompatibleResponsesAdapterServer` 中识别 top-level `include`
- 如果 include 包含 `file_search_call.results`，则 relay-hosted file_search 执行结果应可观察
- 设计一个兼容输出策略，不破坏 Codex tool loop

建议策略：

1. 默认行为不变。
2. 新增 adapter option：

```ts
exposeHostedToolResultsInResponsesOutput?: boolean | null
```

3. 当 include 请求或 option 开启时，在最终 synthetic Responses output 中附加 relay-specific metadata 或兼容 `file_search_call` item。

必须先写测试定义期望结构，再实现。

### 2.2 标准化 File Search result shape

当前 executor output 是：

```ts
object: "vector_store.search_results.page"
data: [...]
search_results: [...]
```

保留它。

但补齐字段：

- `file_id`
- `filename`
- `score`
- `attributes`
- `content[]`
- `content[].type`
- `content[].text`
- `content[].start_line`
- `content[].end_line`

确保所有 source 都一致。

### 2.3 Metadata filters parity

当前支持：

- `and`
- `or`
- `eq`
- `ne`
- `gt`
- `gte`
- `lt`
- `lte`
- `in`
- `nin`

补测试：

- nested `and/or`
- `property` alias
- missing key
- array compare
- number compare

### 2.4 External VectorStore adapter contract only

不要接 Qdrant/LanceDB/pgvector。

只新增接口：

```ts
export interface CodexProviderRelayVectorStoreFileSearchSourceOptions {
  type?: "vector-store" | null;
  name?: string | null;
  store: CodexProviderRelayVectorStoreAdapter;
}
```

```ts
export interface CodexProviderRelayVectorStoreAdapter {
  search(request: CodexProviderRelayVectorStoreSearchRequest):
    Promise<CodexProviderRelayFileSearchSourceResult>;
}
```

然后让 Qdrant/LanceDB/pgvector 以后作为单独 adapter 实现这个 contract。

### 2.5 Remote docs source contract

新增通用 remote-doc source，而不是接某个具体服务：

```ts
createCodexProviderRelayRemoteDocumentsFileSearchSource({
  name,
  query,
  fetchDocument?
})
```

不引入依赖。

## 测试

新增：

```text
test/file_search_executor.test.ts
```

或拆：

```text
test/file_search_openai_parity.test.ts
```

覆盖：

- include `file_search_call.results`
- max_num_results
- filters
- vector_store_ids maps to source names
- remote-doc source
- vector-store adapter source
- all sources output normalized content shape

---

# Phase 3：Web Search v2 Parity

当前 web_search executor 支持 Tavily / Brave / Serper，但只覆盖了简单 query。

## 任务

### 3.1 支持新 web_search fields

新增参数解析：

- `query`
- `search_context_size`
- `user_location`
- `filters`
- `external_web_access`
- `return_token_budget`

注意：

- `web_search_preview` 不支持新字段，只作为 legacy alias。
- `external_web_access: false` 时，不能调用 live provider；如果没有缓存 source，应返回明确错误或空结果，不能悄悄联网。
- `return_token_budget` 可以先透传到 executor request metadata，不必所有 provider 都支持。

### 3.2 Web Search source contract

不要把 Tavily/Brave/Serper 写死为唯一方式。

新增：

```ts
CodexProviderRelayWebSearchSource
```

现有 Tavily/Brave/Serper 可以变成 source adapter。

### 3.3 Output parity

当前 output 是：

```ts
{ query, provider, answer?, results: [{ title, url, snippet }] }
```

继续保留，同时新增可选：

- `sources`
- `citations`
- `retrieved_at`
- `external_web_access`
- `search_context_size`

### 3.4 Tests

新增：

- `web_search` canonical tool converts to relay function
- `web_search_preview` legacy alias works
- `external_web_access: false` prevents live provider
- `filters` are passed to executor
- `return_token_budget` is preserved in request metadata
- streaming hosted tool SSE still works

---

# Phase 4：Tool Search

OpenAI `tool_search` 用于动态加载工具定义。这个很适合 Codex Provider Relay。

## 设计

`tool_search` 不应该直接执行业务工具，而是返回候选工具定义。

新增：

```ts
CodexProviderRelayToolSearchExecutor
```

输入：

```ts
{
  goal?: string;
  query?: string;
  availableTools?: ...
}
```

输出：

```ts
{
  tools: JsonRecord[];
  namespaces?: JsonRecord[];
}
```

## 行为

对于 Chat Completions upstream：

1. 初始请求只暴露 `relay_tool_search` function。
2. 模型调用 `relay_tool_search`。
3. relay executor 返回工具定义。
4. relay 把工具定义追加到下一轮 Chat request 的 `tools`。
5. 模型再选择真实工具。

## 测试

- tool_search 被转换成 relay function
- tool_search executor 返回 tools 后，下一轮 upstream request 包含 deferred tools
- streaming path 不破坏
- 未注册 executor 时明确报错或不暴露 capability

---

# Phase 5：Image Generation Tool

OpenAI tool name: `image_generation`。  
输出通常是 `image_generation_call`，result 是 base64 图像。

## 设计

新增：

```text
src/image_generation_executor.ts
```

类型：

```ts
CodexProviderRelayImageGenerationExecutorOptions
CodexProviderRelayImageGenerationExecutorContent
CodexProviderRelayImageGenerationResult
```

Executor contract：

```ts
{
  prompt: string;
  size?: string;
  quality?: string;
  background?: string;
  output_format?: string;
  n?: number;
}
```

输出：

```ts
{
  images: [
    {
      b64_json?: string;
      url?: string;
      mime_type?: string;
      revised_prompt?: string;
    }
  ]
}
```

## 行为

- 默认不内置任何 image provider。
- 可以提供 OpenAI-compatible image API provider factory。
- 对非 OpenAI Chat upstream，暴露 `relay_image_generation` function。
- 工具执行后，把图片结果以 compact JSON 作为 tool output 回传模型。
- 如果 host 开启 `exposeHostedToolResultsInResponsesOutput`，在 Responses output 中追加 `image_generation_call` 兼容项。

## 测试

- image_generation tool declaration -> Chat function
- executor receives prompt and options
- non-streaming loop returns final answer
- optional Responses output includes `image_generation_call`
- no executor -> not exposed / clear error

---

# Phase 6：Code Interpreter Tool

OpenAI tool name: `code_interpreter`。  
有 container 概念。

## 设计

新增：

```text
src/code_interpreter_executor.ts
```

不要默认执行本地代码。只定义 executor contract。

Executor request：

```ts
{
  code?: string;
  language?: "python" | "javascript" | string;
  container?: "auto" | string | { type: "auto"; memory_limit?: string };
  files?: Array<{ file_id?: string; filename?: string; content?: string }>;
}
```

Executor result：

```ts
{
  stdout?: string;
  stderr?: string;
  result?: unknown;
  files?: Array<{ filename: string; mime_type?: string; b64_data?: string; uri?: string }>;
  metadata?: JsonRecord;
}
```

## 行为

- `code_interpreter` exposed only when relay-emulated declaration + executor registered.
- No default executor.
- Host can bind Docker, Pyodide, remote sandbox, or OpenAI container API.
- Support hosted_tool SSE deltas for stdout/stderr.

## 测试

- schema conversion
- executor call
- stdout/stderr streaming via hosted tool SSE
- tool output appended to follow-up upstream request
- no executor -> not exposed / clear error

---

# Phase 7：Computer Tool

OpenAI GA tool name: `computer`。  
Legacy alias: `computer_use_preview` / existing internal `computer_use`.

## 设计

新增 canonical hosted tool:

```ts
"computer"
```

保留 alias：

```ts
computer_use -> computer
computer_use_preview -> computer
```

Executor contract：

```ts
CodexProviderRelayComputerExecutor
```

Request:

```ts
{
  actions: Array<
    | { type: "click"; x: number; y: number; button?: string }
    | { type: "double_click"; x: number; y: number }
    | { type: "scroll"; x?: number; y?: number; scroll_x?: number; scroll_y?: number }
    | { type: "type"; text: string }
    | { type: "wait"; ms?: number }
    | { type: "keypress"; keys: string[] }
    | { type: "drag"; path: Array<{ x: number; y: number }> }
    | { type: "move"; x: number; y: number }
    | { type: "screenshot" }
  >;
  display?: { width?: number; height?: number; environment?: string };
}
```

Result:

```ts
{
  screenshot?: {
    image_url?: string;
    b64_png?: string;
    detail?: "low" | "high" | "original";
  };
  observations?: string[];
}
```

## 行为

- 默认不启用。
- 不做真实本地电脑控制。
- Host 必须显式提供 executor。
- 对 Codex app-server，如果 Codex 自己拥有 computer/local tools，应优先走 `codex-local-first`，不要 relay-emulated 抢执行。
- 对非 OpenAI Chat upstream，可暴露 `relay_computer` function。

## 测试

- aliases normalize to `computer`
- relay function schema generated
- executor receives actions
- screenshot output appends to model loop
- unsafe default disabled

---

# Phase 8：Package independence hardening

当前包还是：

```json
"version": "0.0.0",
"private": true
```

这表示还不是 public SDK。

## 任务

### 8.1 命名去 gateway 化

保留旧 alias，但新增正式名称：

- `CodexProviderRelayTraceEvent`
- `CodexProviderRelayTraceSink`
- `createCodexProviderRelayStandaloneServerConfigFromEnv`
- `createCodexProviderRelayStandaloneServerFromEnv`
- `loadCodexProviderRelayStandaloneEnvFile`
- `resolveCodexProviderRelayStandaloneServerEnv`

旧的：

- `CodexGatewayTraceEvent`
- `CodexGatewayTraceSink`
- `createCodexGatewayStandaloneServerFromEnv`

保留并标注 deprecated。

### 8.2 Public examples

新增：

```text
packages/codex-provider-relay/examples/
```

至少：

```text
mixed-openrouter-runtime.ts
relay-emulated-web-search.ts
relay-emulated-file-search-local-vector.ts
relay-emulated-image-generation.ts
relay-emulated-code-interpreter-custom-executor.ts
codexnext-integration.ts
```

### 8.3 Docs

新增：

```text
packages/codex-provider-relay/docs/OPENAI_BUILTIN_TOOL_COMPATIBILITY.md
packages/codex-provider-relay/docs/INDEPENDENT_PACKAGE_CHECKLIST.md
packages/codex-provider-relay/docs/RECIPES.md
```

### 8.4 Package readiness checklist

保持 private true，直到以下完成：

- root exports 只暴露稳定 API
- gateway naming 全部有 provider relay alias
- no host-app imports
- docs recipes complete
- test/typecheck/build pass
- live smoke docs complete
- security notes for unsafe tools
- package name / scope / version strategy decided

## 测试命令

优先在包目录运行：

```bash
cd packages/codex-provider-relay
pnpm test
pnpm typecheck
pnpm build
```

如果 workspace 支持 filter：

```bash
pnpm --filter @codexbridge/codex-provider-relay test
pnpm --filter @codexbridge/codex-provider-relay typecheck
pnpm --filter @codexbridge/codex-provider-relay build
```

## AI 执行指令

请先不要直接改代码。按下面顺序执行：

1. 保存本文档到：

```text
packages/codex-provider-relay/docs/OPENAI_TOOL_PARITY_AND_PACKAGE_HARDENING_HANDOFF.md
```

2. 阅读这些文件：

```text
packages/codex-provider-relay/README.md
packages/codex-provider-relay/package.json
packages/codex-provider-relay/src/index.ts
packages/codex-provider-relay/src/hosted_tools.ts
packages/codex-provider-relay/src/hosted_tool_executors.ts
packages/codex-provider-relay/src/converters/responses_adapter.ts
packages/codex-provider-relay/src/server/responses_adapter_server.ts
packages/codex-provider-relay/src/file_search_executor.ts
packages/codex-provider-relay/src/file-search/types.ts
packages/codex-provider-relay/src/file-search/executor.ts
packages/codex-provider-relay/src/file-search/local-vector-index.ts
packages/codex-provider-relay/src/file-search/stores.ts
packages/codex-provider-relay/src/file-search/shared.ts
packages/codex-provider-relay/src/file-search/sources/local-vector.ts
packages/codex-provider-relay/src/web_search_executor.ts
packages/codex-provider-relay/test/file_search_executor.test.ts
packages/codex-provider-relay/test/server.test.ts
packages/codex-provider-relay/test/public_surface.test.ts
```

3. 阅读 OpenAI 当前工具文档，确认工具名称和请求/响应 shape。

4. 先输出任务理解，必须确认：

- 不重写 file_search
- 不接外部 vector DB
- 不引入 sqlite driver
- 不默认执行危险工具
- 不破坏 public API
- 先做 tool registry 和 compatibility matrix

5. 按 phase 执行，每个 phase 都要有测试。

6. 每次提交都输出：

- 修改文件
- 完成内容
- 测试结果
- 仍未完成项
- 是否有 public API 变化
- 是否引入新依赖

## 推荐第一批 PR

不要一次做完所有工具。建议拆 PR：

### PR 1

```text
builtin-tools registry + compatibility docs + hosted tool alias normalization
```

### PR 2

```text
file_search OpenAI include/results parity + remote/vector source contracts
```

### PR 3

```text
web_search v2 params + source contract + canonical web_search migration
```

### PR 4

```text
image_generation relay-emulated executor contract
```

### PR 5

```text
code_interpreter executor contract
```

### PR 6

```text
computer tool alias + executor contract
```

### PR 7

```text
package independence hardening + examples + docs
```

## 最终验收目标

完成后，外部应用应该能这样使用：

```ts
import {
  CodexProviderRelayRuntime,
  createCodexProviderRelayFileSearchExecutor,
  createCodexProviderRelayLocalVectorFileSearchSource,
  createCodexProviderRelayEmbeddingsApiProvider,
  createCodexProviderRelayWebSearchExecutor,
} from "@codexbridge/codex-provider-relay";

const runtime = new CodexProviderRelayRuntime({
  apiKey: process.env.OPENROUTER_API_KEY!,
  upstreamBaseUrl: "https://openrouter.ai/api/v1",
  defaultModel: "deepseek/deepseek-chat",
  providerLabel: "openrouter",
  profileMode: "mixed",
  toolStrategy: "relay-emulated",
  hostedTools: [
    { name: "web_search", mode: "relay-emulated" },
    { name: "file_search", mode: "relay-emulated" },
  ],
  hostedToolExecutors: {
    web_search: createCodexProviderRelayWebSearchExecutor(...),
    file_search: createCodexProviderRelayFileSearchExecutor(...),
  },
});

const state = await runtime.start();
// state.codexCliArgs can launch Codex app-server.
```

这才是“独立成包”的判断标准：CodexBridge 只是 consumer，CodexNext 也是 consumer，其他 Codex app-server 也能直接用。
