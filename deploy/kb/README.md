# 知识库检索服务

给智能体用的中文题库检索：全文、正则、语义三种检索，可单独用也可混合排序。

## 现有库

同一批「算网运营认证专区」资料有三个库，来源和处理方式不同，按可信度分工：

| 库 | 文档数 | 内容 | 什么时候查 |
|---|---|---|---|
| `lianTongPartySchool` | 698 | 每门课的摘要 + 知识点清单 | 快速定位考点 |
| `lianTongPartySchoolTranscript` | 2329 | 698 门课 + 1631 个视频的逐条解析和语音转录全文 | 查「老师原话怎么讲」「具体展开」 |
| `lianTongPartySchoolPdf` | 1391 | 原始 PPT 文本，按页拆分，带真实页码 | 核对原始表述 |

**PDF 库最可信**：它是 PDF 文本层的原样提取，没有任何 AI 加工，命中结果里的
`meta.pdf_page` 是 PDF 里的真实页码，可以直接翻原文核对。
转录库是 ASR 结果，会有听错字（「海缆」听成「海冷」、「熔接」听成「溶接」），
只适合看讲解脉络。两者冲突时以 PDF 为准。

## 转录清洗规则

`tools/kb/clean_transcript.py` 只做两件事：去时间戳、去无实义语气词。
设计原则是**宁可漏删，不可误删**——漏删只是噪声，误删是事故。

| 处理 | 内容 |
|---|---|
| 删除 | `[00:14]` 这类时间戳、「共 1207 段…」说明行 |
| 删除 | `呃` `嗯` `哦` `唉` `诶` `欸`，以及两侧非汉字的 `额` |
| 删除 | `那么` `就是说` `所以说` `然后呢` `对吧` `是吧` `对不对` `你知道吧` |
| 删除 | 句尾语气词 `呢吧嘛呀哈啊呗`（紧跟标点时） |
| 保留 | `这个` `那个`（指示代词，「这个参数」删了就剩「参数」） |
| 保留 | `的话呢`（条件句标记）、`好不好`（实义评价） |
| 保留 | `也就是说`（正常连接词，只删孤立的「就是说」） |
| 保留 | `花呢` `毛呢`（面料词，句尾「呢」加 lookbehind 排除） |
| 保留 | 所有重复字（见下） |

**不折叠 ASR 卡顿重复。** 最初实现过，实测 42 万处折叠里大半是事故：
数字 `8799`→`879`、`3327`→`327`，英文缩写 `mme`→`me`、`3gpp`→`3gp`，
正常叠词 `谢谢`→`谢`、`仅仅`→`仅`、`大大降低`→`大降低`。
术语一旦被压坏，关键词检索直接失效（PDF 里是 `MME`，转录库里成了 `me`）。
重复字在 FTS 里本来就是同一个词元，留着不影响召回，删掉风险远大于收益。

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

**无需鉴权**，所有接口可直接访问。挂在 `/kb` 前缀下，
例如 `https://huhuanjie.site/kb/v1/search`。

`/kb` 是目录型挂载点，缺尾斜杠时由 TLS 代理 308 跳到 `/kb/`，
保证页面里的相对请求（`v1/search`）落在正确前缀下。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 存活与向量加载状态 |
| GET | `/v1/libraries` | 可访问的知识库与文档数 |
| GET | `/v1/agent-card` | 给智能体的自描述：接入方式、可用库、模式说明 |
| POST | `/v1/search` | 检索，body 见下 |
| GET | `/v1/search?q=...` | 检索的 GET 形式，便于 URL 直传 |
| GET | `/v1/search?query=...` | 同上，`query` 与 `q` 等价 |
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

**`query` 和 `q` 等价**，GET 的 query string 和 POST 的 body 都同时接受这两个名字。
两个都传时以 `query` 为准。这是为了兼容两种常见调用习惯：GET 用 `q=`，
POST 用 `{"query": ...}`。

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
# 3. 服务器装载
cd /opt/kb/service && python3 load_index.py \
  --index /opt/kb/upload/<新库>.index.json \
  --vectors /opt/kb/upload/<新库>.vectors.npz
```

`build_index.py` 的 job 文件字段：`library`、`title`、`input`（源 JSON）、
`id_field`、`title_field`。源文件可以是 `{courses: [...]}`、`{items: [...]}` 或纯数组。

**同名库总是整体替换**，重复执行不会翻倍（旧版本要靠 `--replace`，忘了加就会翻倍）。

**所有库必须使用同一套编码模型**（当前是 `bge-small-zh-onnx`，512 维）。
检索时所有库共用同一个查询向量，维度不同会直接 500；`load_index.py`
导入前会做一致性检查并明确报错。

新增第二个库之后，**接口完全不变**：`library` 换成新库名即可；
不传 `library` 则查全部库，跨库用 RRF 按各库内部排名融合
（不同模式的分数量纲不可比，只有排名可比）。

## 调用示例

```bash
# 列出库
curl https://huhuanjie.site/kb/v1/libraries

# 查全部库（不传 library，跨库 RRF 融合）
curl "https://huhuanjie.site/kb/v1/search?q=北斗短报文&mode=hybrid&top_k=5"

# 关键词
curl "https://huhuanjie.site/kb/v1/search?q=北斗短报文&library=lianTongPartySchool&mode=keyword&top_k=5"

# 正则
curl -X POST https://huhuanjie.site/kb/v1/search -H 'content-type: application/json' \
  -d '{"query":"R1[6-8]","library":"lianTongPartySchool","mode":"regex","top_k":5}'

# 语义
curl "https://huhuanjie.site/kb/v1/search?q=卫星和手机网络怎么连起来&library=lianTongPartySchool&mode=semantic&top_k=5"
```

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

