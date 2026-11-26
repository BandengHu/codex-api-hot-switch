# 知识库检索服务

给智能体用的中文题库检索：全文、正则、语义三种检索，可单独用也可混合排序。

## 架构：向量在本地算，服务器只查询

```
本地                                   服务器
├─ tools/kb/build_index.py              ├─ deploy/kb/app.py         HTTP 服务
│   ├─ jieba 分块                       ├─ deploy/kb/index_store.py SQLite + FTS5
│   ├─ bge-small-zh 编码                ├─ deploy/kb/server_search.py 三路融合
│   └─ 导出 .index.json + .vectors.npz  └─ deploy/kb/embedder.py   查询编码
└─ 上传两个文件 → load_index.py 装载
```

**为什么不在服务器编码索引**：这台机器只有 3.5G 内存，1.6 万块编码要占 20 分钟 CPU
并挤占线上中转；本地 10 分钟跑完，服务器只承担「查询 → 一个向量」，约 5ms。

**为什么不用 sqlite-vec**：实测该扩展在 1.6 万条 512 维向量上 kNN 查询卡死
（100% CPU 持续 100 秒以上），而 numpy 矩阵点积同数据量只要约 1ms。

## 接口

所有接口需要 `x-api-key`（或 `Authorization: Bearer`）。挂在 `/kb` 前缀下，
例如 `https://huhuanjie.site/kb/v1/search`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 存活与向量加载状态，不需要 Key |
| GET | `/v1/libraries` | 可访问的知识库与文档数 |
| GET | `/v1/agent-card` | 给智能体的自描述：接入方式、可用库、模式说明 |
| POST | `/v1/search` | 检索，body 见下 |
| GET | `/v1/search?q=...` | 检索的 GET 形式，便于 URL 直传 |
| POST | `/v1/embed` | 文本转向量，便于调用方自己做缓存 |
| GET | `/v1/documents/{id}` | 取整篇文档（含全部分块） |
| POST | `/v1/reload` | 上传新索引后热加载向量，不重启 |

检索 body：

```json
{
  "query": "北斗和5G怎么融合",
  "library": "lianTongPartySchool",
  "mode": "hybrid",
  "top_k": 8,
  "query_vector": null,
  "auto_embed": true
}
```

`mode` 可选：`hybrid`（默认，关键词+向量 RRF 融合）、`keyword`、`semantic`、`regex`。
`query_vector` 为空时服务端自动编码；调用方已有向量可以直接传入，省一次编码。

### 正则检索为什么全库扫描

正则的语义边界和 FTS 词元边界不一致，实测会被粗召回漏掉：`R1[6-8]` 里
最长的字面量是 `R1`，而 FTS 里根本没有 `R1` 这个词元（只有 `R16`、`R19`），
精确匹配返回 0 条；换成前缀匹配又会召回一堆含 `R1` 的无关分块，程序看到
「有结果」就不再往下扫，最终正则在候选集里一条都没匹配上，返回 0 条命中。

所以 `mode=regex` 直接逐条扫完整库（SQLite 流式游标，不一次性载入内存）：
1.6 万条全扫 55~100ms，命中就提前退出。同一篇文档的标题按 `document_id`
缓存一次匹配结果，避免被名下每个分块重复正则。

## 新增题库

完全不影响已有库：一个库一份索引文件，检索时按 `library` 隔离。

```bash
# 1. 本地构建
python tools/kb/build_index.py --job tools/kb/jobs/<新库>.json --out build/kb

# 2. 上传两个文件到 /opt/kb/upload/
# 3. 服务器装载（--replace 只影响同名库）
cd /opt/kb/service && python3 load_index.py \
  --index /opt/kb/upload/<新库>.index.json \
  --vectors /opt/kb/upload/<新库>.vectors.npz
```

`build_index.py` 的 job 文件字段：`library`、`title`、`input`（源 JSON）、
`id_field`、`title_field`。源文件可以是 `{courses: [...]}`、`{items: [...]}` 或纯数组。

## 部署

```bash
cp deploy/kb/systemd/kb.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now kb.service
```

服务只监听 `127.0.0.1:54142`，443 由 `deploy/server/tls-proxy.cjs` 按 `/kb` 前缀转发，
与中转应用共用证书和域名。`SWITCHGATE_KB_PREFIX` 置空可关闭该路由。

## 实测

| 场景 | 延迟 |
|---|---|
| keyword x10 平均 | 15.9 ms |
| semantic x10 平均 | 17.9 ms |
| hybrid x10 平均 | 40.1 ms |
| regex 命中提前退出 | 0~50 ms |
| regex 全扫不命中 | 55~100 ms |

检索质量抽样（698 门课 / 16344 分块）：

| 提问 | 命中 |
|---|---|
| 卫星导航和5G怎么结合 | 卫星轨道分布与星地融合、3GPP NTN（相似度 0.66 / 0.65） |
| 对抗样本攻击怎么防御 | 对抗训练、对抗样本检测（相似度 0.68 / 0.63） |
| 北斗短报文 | 《天地一体与通导融合》关键词节 |
| 5G.{0,6}切片 | 5G专网产品（切片）介绍 |
| R1[6-8] | 《天地一体与通导融合》，matched=R16 |
| eMBB.{0,3}uRLLC | 无线通信技术原理，matched=eMBB、uRLLC |

