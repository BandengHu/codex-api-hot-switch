# CodexProvider Rename & Extraction Handoff

## 背景

当前仓库：`Gan-Xing/CodexBridge`
当前包目录：`packages/codex-provider-relay`
当前包名：`@codexbridge/codex-provider-relay`
目标产品名：`CodexProvider`
目标 npm 包名：`@codex-provider/core`
目标核心类：`CodexProviderRuntime`
目标工具函数示例：`createCodexProviderFileSearchExecutor`

当前包已经完成了大量“独立包前置工作”：

- Hosted tool registry 已存在。
- `web_search` / `file_search` / `tool_search` / `image_generation` / `code_interpreter` / `computer` 等 executor contract 已开始形成。
- File search/local vector 已经基本具备独立 SDK 能力。
- README、compatibility matrix、recipes、examples、release readiness、unsafe tool security 文档已经存在。
- Checklist 已明确：最后 blocker 是 package scope/product name/version/release workflow，以及 live smoke 真实执行记录。

现在进入品牌和包边界迁移阶段。
目标是让这个包从 CodexBridge 的内部包毕业为独立产品：**CodexProvider**。

---

## 总体判断

不要马上 public publish。
不要马上删除旧 alias。
不要先做 live smoke recipes 作为第一步。

当前最优顺序：

1. 在现有 monorepo 内完成 public API 命名迁移：
   - `@codexbridge/codex-provider-relay` -> `@codex-provider/core`
   - `CodexProviderRelayRuntime` -> `CodexProviderRuntime`
   - `createCodexProviderRelayFileSearchExecutor` -> `createCodexProviderFileSearchExecutor`
   - 其他 public API 同步新增 `CodexProvider*` 名称。
2. 保留旧 `CodexProviderRelay*` / `CodexGateway*` aliases 一个 stabilization cycle。
3. 更新 docs/examples/tests/scripts/checklist。
4. 用 CodexNext 或 standalone harness 通过 root entrypoint 消费新 API。
5. 再创建独立仓库 `CodexProvider`，把包抽出去。
6. 最后再做 live smoke、version、changelog、release workflow、npm publish。

理由：

- 现在如果先做 live smoke，得到的证据会绑定旧包名和旧 API。
- 现在如果直接新建仓库，会复制一批旧命名，后面迁移成本更高。
- 先在 monorepo 完成 rename，可用现有测试/边界检查保护迁移质量。

---

## 非目标

本阶段不要做：

- 不要新增外部 vector DB adapter。
- 不要引入 sqlite driver、qdrant、lancedb、pgvector 等依赖。
- 不要默认启用 code interpreter / computer / shell。
- 不要删除旧 public aliases。
- 不要马上 `private: false`。
- 不要发布 npm。
- 不要把 CodexBridge / CodexNext 的 host state 移入包。
- 不要把 current package 逻辑重写成另一个架构。

---

## Phase 0：保存本 handoff 并核对当前状态

把本文档保存到：

```text
packages/codex-provider-relay/docs/CODEX_PROVIDER_RENAME_AND_EXTRACTION_HANDOFF.md
```

先阅读：

```text
packages/codex-provider-relay/package.json
packages/codex-provider-relay/README.md
packages/codex-provider-relay/docs/RELEASE_READINESS.md
packages/codex-provider-relay/docs/INDEPENDENT_PACKAGE_CHECKLIST.md
packages/codex-provider-relay/docs/OPENAI_BUILTIN_TOOL_COMPATIBILITY.md
packages/codex-provider-relay/src/index.ts
packages/codex-provider-relay/src/runtime.ts
packages/codex-provider-relay/src/profiles.ts
packages/codex-provider-relay/src/codex_config.ts
packages/codex-provider-relay/src/target.ts
packages/codex-provider-relay/src/file_search_executor.ts
packages/codex-provider-relay/src/web_search_executor.ts
packages/codex-provider-relay/src/image_generation_executor.ts
packages/codex-provider-relay/src/code_interpreter_executor.ts
packages/codex-provider-relay/src/computer_executor.ts
packages/codex-provider-relay/src/tool_search_executor.ts
packages/codex-provider-relay/src/hosted_tools.ts
packages/codex-provider-relay/src/hosted_tool_executors.ts
packages/codex-provider-relay/src/server/standalone_server.ts
packages/codex-provider-relay/src/server/responses_adapter_server.ts
packages/codex-provider-relay/test/public_surface.test.ts
scripts/check-codex-provider-relay-boundary.mjs
package.json
```

先输出任务理解，不要直接改代码。

必须确认：

- 目标产品名是 `CodexProvider`。
- 目标 npm 包名是 `@codex-provider/core`。
- 旧 `CodexProviderRelay*` 名称需要作为 deprecated alias 保留。
- 旧 `CodexGateway*` 名称继续保留 deprecated alias。
- 本阶段不发布 npm。
- 本阶段不创建实际外部 vector DB adapter。
- 本阶段不改 CodexBridge 业务逻辑。

---

## Phase 1：Public API 新命名 alias，先不移动目录

第一阶段不要先重命名目录。
先让 root entrypoint 暴露新的 public API。

### 1.1 Runtime

目标：

```ts
CodexProviderRuntime
CodexProviderRuntimeOptions
CodexProviderRuntimeState
CodexProviderAdapterServer
CodexProviderAdapterServerOptions
CodexProviderAdapterServerFactory
```

旧名保留：

```ts
CodexProviderRelayRuntime
CodexProviderRelayRuntimeOptions
CodexProviderRelayRuntimeState
CodexProviderRelayAdapterServer
CodexProviderRelayAdapterServerOptions
CodexProviderRelayAdapterServerFactory
```

实现策略：

- 可以在 `runtime.ts` 内重命名 primary class 为 `CodexProviderRuntime`。
- 再导出 alias：

```ts
export { CodexProviderRuntime as CodexProviderRelayRuntime };
export type CodexProviderRelayRuntimeOptions = CodexProviderRuntimeOptions;
```

如果重命名类风险太大，先新增 alias 也可以：

```ts
export const CodexProviderRuntime = CodexProviderRelayRuntime;
```

但最终建议 primary source 名称变为 `CodexProviderRuntime`。

### 1.2 Config / Profile

新增主 API：

```ts
buildCodexProviderConfig
buildCodexProviderCliArgs
buildCodexProviderTomlFragment
buildCodexProviderProfile
CodexProviderProfile
BuildCodexProviderProfileInput
CodexProviderAuthMode
CodexProviderProtocol
CodexProviderToolStrategy
```

旧 API 保留 alias：

```ts
buildCodexProviderRelayConfig
buildCodexProviderRelayCliArgs
buildCodexProviderRelayTomlFragment
buildCodexProviderRelayProfile
CodexProviderRelayProfile
...
```

注意：`CodexProvider` 这个产品名仍然是给 Codex app-server 的 provider bridge，不要改掉 OpenAI-compatible provider capability 命名。

### 1.3 Hosted tools

新增：

```ts
CodexProviderHostedToolName
CodexProviderHostedToolDeclaration
CodexProviderHostedToolExecutor
CodexProviderHostedToolExecutorRegistry
createCodexProviderHostedToolExecutorRegistry
```

旧名保留 alias：

```ts
CodexProviderRelayHostedToolName
CodexProviderRelayHostedToolDeclaration
...
```

### 1.4 Built-in tools

新增：

```ts
CodexProviderBuiltinToolName
CodexProviderBuiltinToolDefinition
CODEX_PROVIDER_BUILTIN_TOOL_DEFINITIONS
CODEX_PROVIDER_BUILTIN_TOOL_ALIASES
```

旧名保留 alias：

```ts
CodexProviderRelayBuiltinToolName
CODEX_PROVIDER_RELAY_BUILTIN_TOOL_DEFINITIONS
...
```

### 1.5 Executors

新增主 API：

```ts
createCodexProviderWebSearchExecutor
createCodexProviderFileSearchExecutor
createCodexProviderLocalFileSearchSource
createCodexProviderLocalVectorFileSearchSource
createCodexProviderMemoryFileSearchSource
createCodexProviderSqliteFtsFileSearchSource
createCodexProviderInMemoryVectorFileSearchSource
createCodexProviderMemoryLocalVectorIndexStore
createCodexProviderSqliteLocalVectorIndexStore
createCodexProviderEmbeddingsApiProvider
createCodexProviderOpenRouterEmbeddingProvider

createCodexProviderImageGenerationExecutor
createCodexProviderOpenAICompatibleImageGenerationProvider
createCodexProviderCodeInterpreterExecutor
createCodexProviderComputerExecutor
createCodexProviderToolSearchExecutor
```

旧名全部保留 alias：

```ts
createCodexProviderRelayFileSearchExecutor
...
```

### 1.6 Server / CLI / trace

新增主 API：

```ts
CodexProviderTraceEvent
CodexProviderTraceSink
CodexProviderStandaloneServerConfig
createCodexProviderStandaloneServerConfigFromEnv
createCodexProviderStandaloneServerFromEnv
loadCodexProviderStandaloneEnvFile
resolveCodexProviderStandaloneServerEnv
```

旧名保留：

```ts
CodexProviderRelayTraceEvent
CodexProviderRelayTraceSink
CodexGatewayTraceEvent
CodexGatewayTraceSink
createCodexProviderRelayStandaloneServerFromEnv
createCodexGatewayStandaloneServerFromEnv
...
```

### 1.7 Target constants

新增：

```ts
CODEX_PROVIDER_TARGET
CODEX_PROVIDER_TARGET_ZH
CODEX_PROVIDER_PACKAGE_NAME
CODEX_PROVIDER_PACKAGE_PHASE
CODEX_PROVIDER_RELEASE_CHANNEL
CODEX_PROVIDER_OWNS
CODEX_PROVIDER_DOES_NOT_OWN
CODEX_PROVIDER_INVARIANTS
CODEX_PROVIDER_NON_GOALS
```

旧名保留 alias：

```ts
CODEX_PROVIDER_RELAY_TARGET
CODEX_PROVIDER_RELAY_PACKAGE_NAME
...
```

### 1.8 Tests

更新：

```text
packages/codex-provider-relay/test/public_surface.test.ts
```

测试必须确认：

- 新 API 存在。
- 旧 API 仍存在。
- 新 package name constant 是 `@codex-provider/core`。
- 旧 package name constant 作为 deprecated alias 指向新值或旧值的兼容策略明确。

推荐策略：

```ts
CODEX_PROVIDER_PACKAGE_NAME === "@codex-provider/core"
CODEX_PROVIDER_RELAY_PACKAGE_NAME === "@codex-provider/core"
```

如果担心兼容，可额外保留：

```ts
LEGACY_CODEX_PROVIDER_RELAY_PACKAGE_NAME === "@codexbridge/codex-provider-relay"
```

---

## Phase 2：package.json 改名，但保持 private

修改：

```text
packages/codex-provider-relay/package.json
```

从：

```json
{
  "name": "@codexbridge/codex-provider-relay",
  "version": "0.0.0",
  "private": true
}
```

改为：

```json
{
  "name": "@codex-provider/core",
  "version": "0.1.0-alpha.0",
  "private": true,
  "description": "Provider compatibility SDK that lets non-OpenAI models participate in the Codex native tool-call loop."
}
```

bin 建议：

```json
"bin": {
  "codex-provider-server": "./dist/cli.js",
  "codex-provider-relay-server": "./dist/cli.js",
  "codex-gateway-server": "./dist/cli.js"
}
```

说明：

- 新 bin 是主入口。
- 旧 bin 保留 deprecated alias。
- 仍然 `private: true`。
- 不发布 npm。

更新根 `package.json` scripts：

新增：

```json
"codex-provider:build": "tsc -p packages/codex-provider-relay/tsconfig.json",
"codex-provider:check-boundary": "node scripts/check-codex-provider-relay-boundary.mjs",
"codex-provider:test": "tsx --test packages/codex-provider-relay/test/*.test.ts",
"codex-provider:typecheck": "tsc -p packages/codex-provider-relay/tsconfig.json --noEmit"
```

旧 scripts 保留：

```json
"codex-provider-relay:*"
```

---

## Phase 3：文档和 examples 迁移到新品牌

更新这些文件中面向用户的主名称：

```text
packages/codex-provider-relay/README.md
packages/codex-provider-relay/docs/RELEASE_READINESS.md
packages/codex-provider-relay/docs/INDEPENDENT_PACKAGE_CHECKLIST.md
packages/codex-provider-relay/docs/OPENAI_BUILTIN_TOOL_COMPATIBILITY.md
packages/codex-provider-relay/docs/RECIPES.md
packages/codex-provider-relay/docs/LIVE_SMOKE_RECIPES.md
packages/codex-provider-relay/docs/UNSAFE_TOOL_SECURITY.md
packages/codex-provider-relay/examples/*.ts
```

主文案：

```text
CodexProvider
@codex-provider/core
CodexProviderRuntime
createCodexProviderFileSearchExecutor
```

保留一段 compatibility note：

```text
Historical names under @codexbridge/codex-provider-relay and CodexProviderRelay* remain as deprecated aliases during the stabilization cycle.
```

README 开头建议改成：

```md
# CodexProvider

`@codex-provider/core` is a provider compatibility SDK for Codex app-server integrations. It lets non-OpenAI models participate in the Codex native tool-call loop by exposing a Responses-compatible surface over provider-specific Chat Completions APIs.
```

不要再把 CodexBridge 放在第一段里。
CodexBridge / CodexNext 只作为 consumers 出现在 examples 或 compatibility docs 中。

---

## Phase 4：可选目录重命名

只有在 Phase 1-3 通过后，再考虑目录重命名。

当前目录：

```text
packages/codex-provider-relay
```

建议新目录：

```text
packages/codex-provider-core
```

需要同步更新：

```text
root package.json scripts
tsconfig references, if any
scripts/check-codex-provider-relay-boundary.mjs
docs links
examples path comments
test names
```

边界检查脚本建议改为：

```text
scripts/check-codex-provider-boundary.mjs
```

旧脚本保留 alias：

```text
scripts/check-codex-provider-relay-boundary.mjs
```

旧脚本可以直接调用新脚本，避免破坏 CI。

如果担心这一步太大，可以先不改目录。
对 npm 独立包来说，package name 比 monorepo directory name 更重要。

---

## Phase 5：外部 consumer 验证

在发布前必须证明这个包不是 CodexBridge 内部包。

二选一：

### Option A：CodexNext 作为真实 consumer

在 CodexNext 中添加依赖：

```json
"@codex-provider/core": "workspace:*"
```

如果还没跨仓 workspace，就先用 local path / git submodule / packed tarball。

实现一个最小 harness：

```ts
import {
  CodexProviderRuntime,
  createCodexProviderFileSearchExecutor,
  createCodexProviderLocalVectorFileSearchSource,
  createCodexProviderEmbeddingsApiProvider,
} from "@codex-provider/core";
```

验证：

- 不 import CodexBridge 内部路径。
- 可以 start runtime。
- 可以拿到 `state.codexCliArgs`。
- 可以注册 `file_search` / `web_search` executor。
- 可以作为 Codex app-server provider config 来源。

### Option B：standalone app-server harness

在当前 repo 或新 repo 建：

```text
examples/standalone-codex-provider-harness.ts
```

这个 harness 只依赖 `@codex-provider/core` root entrypoint。

验证：

```ts
new CodexProviderRuntime(...)
await runtime.start()
fetch(`${state.adapterBaseUrl}/responses`, ...)
await runtime.stop()
```

必须证明：

- 不依赖 CodexBridge。
- 不依赖 WeChat/Telegram/web UI。
- 不依赖 host session store。

---

## Phase 6：决定是否新建独立仓库

推荐仓库名：

```text
Gan-Xing/CodexProvider
```

推荐 repo 结构：

```text
CodexProvider/
  package.json
  tsconfig.json
  src/
  test/
  docs/
  examples/
  scripts/
  README.md
  CHANGELOG.md
  LICENSE
```

也可以先保持 monorepo package 结构：

```text
CodexProvider/
  packages/core/
```

但如果目前只有一个包，建议直接 repo root 就是 `@codex-provider/core`。

### 迁移策略

推荐顺序：

1. 当前 monorepo 完成 rename。
2. 当前 monorepo test/typecheck/build 通过。
3. 用 CodexNext 或 standalone harness 验证 root entrypoint。
4. 创建 `CodexProvider` 新仓库。
5. 使用 `git filter-repo` 或手动复制包目录。

如果保留历史：

```bash
git filter-repo \
  --path packages/codex-provider-core/ \
  --path-rename packages/codex-provider-core/:
```

如果不保留历史：

```bash
mkdir CodexProvider
cp -R packages/codex-provider-core/* ../CodexProvider/
```

### 新仓库必须补

```text
README.md
LICENSE
CHANGELOG.md
.github/workflows/ci.yml
docs/RELEASE_READINESS.md
docs/UNSAFE_TOOL_SECURITY.md
examples/
```

CI 最低要求：

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
npm pack --dry-run
```

---

## Phase 7：包名和 scope 确认

目标包名：

```text
@codex-provider/core
```

执行前必须人工确认：

```bash
npm view @codex-provider/core
npm view @codex-provider
```

如果 scope 不存在，需要在 npm 创建 organization/scope：

```text
codex-provider
```

如果不可用，备选：

```text
@codexprovider/core
@open-codex-provider/core
@codex-runtime/provider
codex-provider-core
```

但首选仍然是：

```text
@codex-provider/core
```

注意：不要在未确认 scope 可用前删除旧包名兼容记录。

---

## Phase 8：发布前版本策略

建议：

```json
"version": "0.1.0-alpha.0",
"private": true
```

完成 live smoke 和 consumer validation 后：

```json
"version": "0.1.0",
"private": false
```

新增：

```text
CHANGELOG.md
```

初始内容：

```md
# Changelog

## 0.1.0-alpha.0

- Rename internal codex-provider-relay package to CodexProvider public API.
- Add `@codex-provider/core` package metadata while keeping `private: true`.
- Add `CodexProviderRuntime` and `createCodexProvider*` public APIs.
- Keep deprecated `CodexProviderRelay*` and `CodexGateway*` aliases.
- Preserve explicit hosted tool executor model.
```

---

## Phase 9：live smoke 重新执行并记录

改名后再执行 live smoke。

需要记录到：

```text
packages/codex-provider-relay/docs/LIVE_SMOKE_RESULTS.md
```

如果已改目录，则：

```text
packages/codex-provider-core/docs/LIVE_SMOKE_RESULTS.md
```

每条记录包括：

- Date
- Provider
- Model
- Env keys used, redacted
- Request shape
- Response shape
- Tool mode
- Result
- Known incompatibility
- Cost/latency notes

不要提交 API key、完整绝对路径、私有文件内容。

---

## 验收命令

在当前 monorepo 阶段：

```bash
npm run codex-provider:test
npm run codex-provider:typecheck
npm run codex-provider:build
npm run codex-provider:check-boundary
git diff --check
```

旧命令也必须继续通过：

```bash
npm run codex-provider-relay:test
npm run codex-provider-relay:typecheck
npm run codex-provider-relay:build
npm run codex-provider-relay:check-boundary
```

包目录阶段：

```bash
cd packages/codex-provider-relay
pnpm test
pnpm typecheck
pnpm build
pnpm pack --dry-run
```

新仓库阶段：

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm pack --dry-run
```

---

## 推荐第一批 PR

### PR 1：public API rename aliases

标题：

```text
refactor(provider): add CodexProvider public API aliases
```

范围：

- runtime/config/profile/hosted tools/executors/standalone server/target constants 新增 `CodexProvider*`
- 旧 alias 保留
- public surface tests 更新

### PR 2：package metadata rename

标题：

```text
chore(provider): rename package metadata to @codex-provider/core
```

范围：

- package.json name/version/bin
- root scripts 新增 `codex-provider:*`
- docs/checklist/release readiness 更新
- README 开头改成 CodexProvider

### PR 3：examples/docs migration

标题：

```text
docs(provider): migrate recipes and examples to CodexProvider naming
```

范围：

- examples imports 使用 `@codex-provider/core`
- docs 使用 CodexProvider 主名
- compatibility note 说明旧名 deprecated

### PR 4：consumer validation

标题：

```text
test(provider): add standalone CodexProvider consumer harness
```

范围：

- 只通过 root entrypoint import
- 不依赖 CodexBridge internals
- runtime start/stop
- file_search/web_search executor wiring

### PR 5：optional directory extraction prep

标题：

```text
chore(provider): prepare CodexProvider repository extraction
```

范围：

- 可选目录改名
- 新 boundary script
- migration doc

---

## 给 AI 的执行 prompt

请执行 CodexProvider rename/extraction 第一阶段。先不要直接改代码，先阅读 handoff 和当前仓库状态。

目标：

- 产品名改为 `CodexProvider`
- npm 包名改为 `@codex-provider/core`
- 新主 API 使用 `CodexProvider*`
- 旧 `CodexProviderRelay*` 和 `CodexGateway*` 保留 deprecated aliases
- 暂不发布 npm
- 暂不删除旧 alias
- 暂不引入新依赖
- 暂不创建外部 vector DB adapter

第一步：保存 handoff 到：

```text
packages/codex-provider-relay/docs/CODEX_PROVIDER_RENAME_AND_EXTRACTION_HANDOFF.md
```

第二步：阅读这些文件：

```text
packages/codex-provider-relay/package.json
packages/codex-provider-relay/README.md
packages/codex-provider-relay/docs/RELEASE_READINESS.md
packages/codex-provider-relay/docs/INDEPENDENT_PACKAGE_CHECKLIST.md
packages/codex-provider-relay/src/index.ts
packages/codex-provider-relay/src/runtime.ts
packages/codex-provider-relay/src/profiles.ts
packages/codex-provider-relay/src/codex_config.ts
packages/codex-provider-relay/src/target.ts
packages/codex-provider-relay/src/file_search_executor.ts
packages/codex-provider-relay/src/web_search_executor.ts
packages/codex-provider-relay/src/image_generation_executor.ts
packages/codex-provider-relay/src/code_interpreter_executor.ts
packages/codex-provider-relay/src/computer_executor.ts
packages/codex-provider-relay/src/tool_search_executor.ts
packages/codex-provider-relay/src/hosted_tools.ts
packages/codex-provider-relay/src/hosted_tool_executors.ts
packages/codex-provider-relay/src/server/standalone_server.ts
packages/codex-provider-relay/src/server/responses_adapter_server.ts
packages/codex-provider-relay/test/public_surface.test.ts
scripts/check-codex-provider-relay-boundary.mjs
package.json
```

第三步：先输出你的理解，不要实现。必须确认：

- 是否会保留旧 alias
- 是否会保持 private true
- 是否不会发布 npm
- 是否不会引入新依赖
- 是否不会移动 CodexBridge host state
- 是否先做 API alias，再做 package metadata

第四步：按 PR 1 开始实现：

```text
refactor(provider): add CodexProvider public API aliases
```

完成后运行：

```bash
npm run codex-provider-relay:test
npm run codex-provider-relay:typecheck
npm run codex-provider-relay:build
npm run codex-provider-relay:check-boundary
git diff --check
```

输出：

- 修改文件
- 新增 API
- 保留的 deprecated alias
- 测试结果
- 未完成项
- 下一 PR 建议
