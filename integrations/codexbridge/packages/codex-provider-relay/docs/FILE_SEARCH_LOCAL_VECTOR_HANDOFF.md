# Codex Provider Relay file_search / Local Vector Index Handoff

## 背景

仓库：Gan-Xing/CodexBridge  
目标包：`packages/codex-provider-relay`

当前方向是让 `file_search` 在 relay-emulated hosted tool 模式下支持本地项目文件检索，并且保持 package 可独立复用，不能依赖 CodexBridge / CodexNext 的宿主状态。

核心目标不是“马上接 Qdrant / LanceDB / pgvector”，而是先把本地向量索引链路稳定下来，使后续 SQLite / 外部向量库都只是替换 store 或 adapter，不改变上层 `CodexProviderRelayFileSearchSource` API。

## 当前已实现状态

当前代码已经不再是旧的单文件实现，已经拆成：

- `packages/codex-provider-relay/src/file-search/types.ts`
- `packages/codex-provider-relay/src/file-search/executor.ts`
- `packages/codex-provider-relay/src/file-search/embeddings.ts`
- `packages/codex-provider-relay/src/file-search/stores.ts`
- `packages/codex-provider-relay/src/file-search/shared.ts`
- `packages/codex-provider-relay/src/file-search/sources/local-vector.ts`
- `packages/codex-provider-relay/src/file-search/sources/local-fs.ts`
- `packages/codex-provider-relay/src/file-search/sources/memory.ts`
- `packages/codex-provider-relay/src/file-search/sources/sqlite-fts.ts`
- `packages/codex-provider-relay/src/file-search/sources/in-memory-vector.ts`

已经存在的关键能力：

1. `CodexProviderRelayLocalVectorFileSearchSourceOptions`
   - 支持 `roots`
   - 支持 `embeddingProvider`
   - 支持 `indexStore`
   - 支持 `chunking`
   - 支持 `vectorWeight / textWeight`
   - 支持 `embeddingBatchSize`

2. `CodexProviderRelayLocalVectorIndexStore`
   - 已有 `getDocument`
   - 已有 `upsertDocument`
   - 已有 `listChunks`
   - 可选 `deleteDocuments`

3. Store 实现
   - `createCodexProviderRelayMemoryLocalVectorIndexStore`
   - `createCodexProviderRelaySqliteLocalVectorIndexStore`

4. Local vector source
   - 显式 roots 扫描
   - 跳过 ignore dirs / ignore extensions
   - 文件 chunk
   - 批量 embedding
   - 文档 / chunk 缓存
   - 基于 size + mtime + embeddingModel 的缓存命中
   - 删除 stale documents
   - 查询时做 query embedding
   - list chunks 后做 cosine + lexical weighted scoring
   - 返回 OpenAI-compatible file_search result shape

5. 测试已经覆盖
   - local-fs search
   - memory documents
   - sqlite FTS source
   - in-memory vector source
   - local-vector chunk + cache
   - local-vector hybrid weights
   - sqlite local-vector store persist
   - sqlite store 跨实例复用

## 这次任务的核心判断

当前代码已经完成了原计划的很多内容：

原计划：
1. LocalVectorIndex + chunker + MemoryIndexStore + LocalVectorFileSearchSource
2. SQLite IndexStore
3. 增量索引
4. Hybrid search
5. 外部 vector store adapter

当前实际状态：
1. 已经基本完成，但 `LocalVectorIndex` 还没有被抽成独立 orchestrator，逻辑仍在 `sources/local-vector.ts`。
2. 已经有 SQLite store，但它是“持久化 embedding cache”，还不是高性能 ANN / vector DB。
3. 已经有基于 `size + mtime + embeddingModel` 的增量缓存，但还缺 chunking/schema/version/dimension/hash 维度。
4. 已经有 weighted hybrid scoring，但还不是真正的 RRF / FTS + vector 双路召回。
5. 还不应该做 Qdrant/LanceDB/pgvector；应该先扩展 store/search 抽象，避免外部 store 被迫 `listChunks()` 全量扫描。

## 本轮建议目标

不要直接接 Qdrant。  
不要大改 public API。  
不要让 `codex-provider-relay` 引入 sqlite driver、qdrant client、lancedb、pgvector 依赖。

本轮目标是：

**把 local-vector 从“能跑”升级成“架构稳定、可替换 store、可扩展到外部 vector DB”的内部索引层。**

## 必做任务

### 任务 1：抽出内部 `LocalVectorIndex` orchestrator

新增文件建议：

- `packages/codex-provider-relay/src/file-search/local-vector-index.ts`

把 `sources/local-vector.ts` 里的以下逻辑抽出来：

- candidate indexing
- stat / content hash / cache decision
- chunking
- embedding batching
- stale document deletion
- query embedding
- chunk scoring / grouping

`createCodexProviderRelayLocalVectorFileSearchSource()` 只保留 source wrapper，调用内部 `LocalVectorIndex.search()`。

不要破坏已有 public exports。  
`LocalVectorIndex` 可以先不从 root public export，避免过早承诺 API。

### 任务 2：增强 IndexStore contract，但保持向后兼容

当前 store 只有：

- `getDocument(id)`
- `upsertDocument(document, chunks)`
- `listChunks(sourceName)`
- `deleteDocuments?(ids)`

建议 additive 扩展可选方法：

- `listDocuments?(sourceName)`
- `searchChunks?(request)`
- `deleteStaleDocuments?(sourceName, liveDocumentIds)`

设计原则：

- memory/sqlite store 先实现 `listDocuments`
- `searchChunks` 先可选，不强制现有 store 实现
- LocalVectorIndex 查询时：
  - 如果 store 有 `searchChunks`，优先使用
  - 否则 fallback 到 `listChunks + in-process cosine`
- 外部 Qdrant / LanceDB / pgvector 以后通过 `searchChunks` 做服务端向量检索，不应该被迫返回全量 chunks。

### 任务 3：完善 cache fingerprint

当前缓存命中条件大致是：

- size 相同
- mtimeMs 相同
- embeddingModel 相同

需要补充：

- `indexVersion`
- `chunkerVersion`
- `chunkingConfigHash`
- `embeddingDimensions`
- `contentHash`
- `contentHashAlgorithm`
- 可选 `statFingerprint`

建议新增文档字段时保持向后兼容：

- 读取旧 store document 时缺字段不要崩
- 缺字段时视为 cache miss
- SQLite schema 可以新增列，或者先把新增字段放进 document metadata JSON；但目前 document 表没有 metadata_json，如果选择新增列，需要补测试。

必须新增测试：

- 修改 chunking.maxChars 后，即使文件没变，也会重新 embedding
- embedding provider model 相同但 dimensions 不同，不能复用旧 chunks
- 文件内容变化时必须重新索引
- 文件删除后 stale document 被删除
- 旧 schema/旧 document 缺少新增 fingerprint 字段时不会崩溃，且会重新索引

### 任务 4：修正 content hash 策略

当前 `stableContentHash()` 是轻量 FNV-1a 风格 hash。

建议改为 Node `crypto.createHash('sha256')`，返回类似：

- `sha256:<hex>:<byteLength>`

理由：

- embedding cache 是成本敏感路径
- hash 碰撞会导致错误复用旧 embedding
- Node 已经有内置 crypto，不需要新增依赖

保留旧 hash 读取兼容，但新写入使用 sha256。

### 任务 5：强化 embedding 批处理校验

当前 `embedTextsInBatches()` 应明确校验：

- `result.embeddings.length === batch.length`
- 每个 embedding 非空
- 每个 embedding 维度一致
- query embedding 维度必须和 stored chunk embedding 维度一致

缺失或维度不一致时：

- indexing 阶段应该 fail fast，避免写入半坏索引
- search 阶段应该跳过维度不匹配 chunk，或者返回可诊断 metadata

建议测试：

- provider 少返回一个 embedding 时抛错
- provider 返回维度不一致时抛错
- store 中已有旧维度 chunk 时不会污染搜索结果

### 任务 6：保留 weighted fusion，但为 RRF 预留接口

现在 `local-vector` 的 hybrid 是：

- vector cosine
- lexicalScoreForText
- weighted sum

这可以保留为第一版。

但不要再把 `rrf_embedding_weight` 字段解释成普通 weight 而不说明。建议内部结构明确：

- `fusion: "weighted" | "rrf"`
- `ranker: "auto"` 默认走 weighted
- 如果 `ranking_options.ranker === "rrf"`，才走 RRF
- RRF 可以先只在 `LocalVectorIndex` 内部实现，不改变外部 executor output

RRF 最低实现：

- dense rank list
- lexical rank list
- 按 `1 / (k + rank)` 合并
- 默认 k = 60
- 最终仍然输出 0 到 1 的 normalized score

新增测试：

- weighted vector-only 时 semantic 文件排第一
- weighted text-only 时 lexical 文件排第一
- rrf 时同时在 dense/text 都靠前的文件排第一

### 任务 7：SQLite store 只做持久化 cache，不要现在做 ANN

`createCodexProviderRelaySqliteLocalVectorIndexStore()` 当前把 embedding JSON 存在 chunks 表里，这适合作为持久化 cache。

本轮不要引入 sqlite-vec。  
本轮不要引入 sqlite driver。  
本轮不要把 SQLite store 变成真正向量数据库。

但可以做：

- `listDocuments(sourceName)`
- schema version
- optional transaction hook
- 更完整的 upsert atomicity

建议为 SQLite options 添加可选 transaction 能力，但不要强制：

- 如果 host DB 支持 transaction，则 upsertDocument 在事务里执行
- 如果没有，则保持当前行为

### 任务 8：保留安全边界

不得破坏这些现有安全行为：

- local-fs/local-vector 必须显式 roots
- 不允许默认扫描 cwd
- 默认忽略 `.git / node_modules / dist / build / coverage`
- 默认忽略二进制/图片/压缩等扩展
- symlink 默认不跟随
- `path_glob` 不能逃出 roots
- max files / max bytes / max payload 继续生效

新增/保留测试：

- path_glob `../*` 抛错
- symlink 默认不跟随
- node_modules 不进入索引
- 大文件不读入 embedding

## 非目标

本轮不要做：

- Qdrant adapter
- LanceDB adapter
- pgvector adapter
- sqlite-vec ANN
- reranker
- code AST chunker
- PDF/docx parsing
- host-app session store
- CodexBridge / CodexNext 专属逻辑

## 推荐测试命令

在仓库根目录运行：

```bash
pnpm --filter @codexbridge/codex-provider-relay test
pnpm --filter @codexbridge/codex-provider-relay typecheck
pnpm --filter @codexbridge/codex-provider-relay build
```

如果当前 workspace 没有 filter 脚本，则进入包目录：

```bash
cd packages/codex-provider-relay
pnpm test
pnpm typecheck
pnpm build
```

## AI 执行提示词

你是负责维护 `packages/codex-provider-relay` 的 TypeScript 工程师。请基于当前仓库实现，完成 local-vector file_search 的架构稳定化工作。

必须先阅读这些文件：

- `packages/codex-provider-relay/src/file-search/types.ts`
- `packages/codex-provider-relay/src/file-search/executor.ts`
- `packages/codex-provider-relay/src/file-search/sources/local-vector.ts`
- `packages/codex-provider-relay/src/file-search/sources/local-shared.ts`
- `packages/codex-provider-relay/src/file-search/stores.ts`
- `packages/codex-provider-relay/src/file-search/shared.ts`
- `packages/codex-provider-relay/src/file-search/embeddings.ts`
- `packages/codex-provider-relay/test/file_search_executor.test.ts`
- `packages/codex-provider-relay/src/index.ts`

请完成：

1. 把 `local-vector.ts` 中的索引/搜索编排逻辑抽到内部 `local-vector-index.ts`。
2. 扩展 `CodexProviderRelayLocalVectorIndexStore`，新增可选 `listDocuments` 和 `searchChunks`，并保持现有 store 兼容。
3. memory store 和 sqlite store 实现 `listDocuments`。
4. LocalVectorIndex 优先调用 `searchChunks`，否则 fallback 到 `listChunks + in-process cosine`。
5. cache fingerprint 增加 chunking config、index version、embedding dimensions、content hash 信息。
6. 新写入 content hash 使用 Node crypto sha256。
7. embedding batch 返回数量和维度必须严格校验。
8. 保留现有 public API 和所有现有测试行为。
9. 添加覆盖 cache miss、chunking 变更、dimension mismatch、stale deletion、sqlite persistence、RRF/weighted hybrid 的测试。
10. 不引入新的运行时依赖，不接 Qdrant/LanceDB/pgvector，不接 sqlite-vec。

完成后运行测试、typecheck、build。输出变更摘要、已通过测试、仍待处理事项。
