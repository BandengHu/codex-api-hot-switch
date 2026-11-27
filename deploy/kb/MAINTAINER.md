# 知识库维护手册（交接给维护智能体）

这份文档面向**维护者**，讲怎么加库、更新库、排障。
只想知道怎么查资料的调用方看 `deploy/kb/README.md`。

文中标注「实测」的结论都在这台机器上真跑过，不是推测。

---

## 一、当前部署实况

| 项 | 值 |
|---|---|
| 服务 | systemd `kb.service`，`Restart=always` |
| 监听 | `127.0.0.1:54142`，由外层 TLS 反代暴露 |
| 对外地址 | `https://huhuanjie.site/kb` |
| 鉴权 | **无**（实测裸调返回 200） |
| 代码目录 | 服务器 `/opt/kb/service`，仓库 `deploy/kb/` |
| 数据 | `/opt/kb/data/kb.sqlite3`（WAL 模式）+ `/opt/kb/data/vectors/*.npz` |
| 上传中转 | `/opt/kb/upload/` |
| 备份 | `/opt/kb/backup/`（已占 562M） |
| 磁盘余量 | **7.1G 可用，已用 83%** ← 加库前先看这个 |

### 现有三个库（全部 512 维）

| 库名 | 文档 | 分块 | 来源 |
|---|---|---|---|
| `lianTongPartySchool` | 698 | 16,344 | AI 结构化总结 |
| `lianTongPartySchoolPdf` | 1,391 | 1,791 | 原始 PDF 按页 |
| `lianTongPartySchoolTranscript` | 2,329 | 50,156 | docx 转录全文 |

三个库可信度不同：**PDF 最可信**（无 AI 加工），转录是 ASR 会有听错字
（「海缆」→「海冷」）。冲突时以 PDF 为准。

---

## 二、架构：向量在本地算，服务器只查

```
本地（有 GPU）                          服务器（3.5G 内存，无 GPU）
├─ parse_pdf.py / parse_docx.py          ├─ app.py         HTTP 服务
├─ build_index.py                        ├─ index_store.py SQLite + FTS5 + 向量矩阵
│   ├─ jieba 分块                        ├─ server_search.py  三路 RRF 融合
│   └─ bge-small-zh 编码                 └─ embedder.py    只编码「查询」这一句
└─ 产出 .index.json + .vectors.npz
        ↓ 上传
   /opt/kb/upload/ → load_index.py 装载进 sqlite
```

**为什么不在服务器编码索引**：这台机器 3.5G 内存，1.6 万块编码要 20 分钟
CPU 并挤占线上中转。本地 DirectML 跑 8 倍快，服务器只承担「一句话 → 一个向量」约 5ms。

**不要在服务器上跑 `build_index.py`**，内存会打爆。

---

## 三、本地构建环境

```powershell
# 必须用这个 venv（DirectML 版 onnxruntime，比 CPU 快约 8 倍）
.\.codex-tmp\venv-dml\Scripts\python.exe tools\kb\build_index.py `
  --job tools\kb\jobs\<库名>.json --out build\kb
```

- 模型默认 `.codex-tmp\models\bge-small-zh-onnx`（可用 `--model` 换）
- 全局 `python` 只有 CPU provider，**别用它构建**，慢 8 倍
- 实测参考：50,156 块用 DirectML 约 613 秒
- 只想强制 CPU 时设 `KB_EMBED_PROVIDER=cpu`

### job 文件字段

```json
{
  "library": "库名（唯一，英文）",
  "title": "给人看的标题",
  "description": "用途说明，会出现在 /v1/libraries",
  "source": "原始资料出处",
  "input": "解析后的 JSON 路径",
  "id_field": "external_id",
  "title_field": "title"
}
```

`input` 支持三种输入格式（`build_index.py` 的 `load_items`）：
- `{"documents": [...]}` ← `parse_pdf.py` / `parse_docx.py` 的输出
- `{"courses": [...]}` 或 `{"items": [...]}`
- 纯数组

---

## 四、三个日常任务

### 任务 A：新增一个库（不影响已有库）

```bash
# 1. 本地解析（按需）
python tools/kb/parse_pdf.py   --pdf  <原文件> --out .codex-tmp/kb-parse/pdf.json
python tools/kb/parse_docx.py  --docx <原文件> --out .codex-tmp/kb-parse/transcripts.json

# 2. 本地构建 → 得到两个文件
.\...\venv-dml\Scripts\python.exe tools\kb\build_index.py --job tools\kb\jobs\<新库>.json --out build\kb

# 3. 上传到 /opt/kb/upload/

# 4. 服务器装载（必须在 service 目录下跑，否则 import 不到 config）
cd /opt/kb/service && python3 load_index.py \
  --index   /opt/kb/upload/<新库>.index.json \
  --vectors /opt/kb/upload/<新库>.vectors.npz

# 5. ★ 必须重载向量（见「铁律 1」）
curl -s -X POST http://127.0.0.1:54142/kb/v1/reload
```

### 任务 B：更新已有库（同名整体替换）

流程同 A，`library` 用同名即可。**同名库会被整体删掉再重建**，不需要 `--replace`
（该参数只为兼容旧脚本保留）。

⚠️ 替换前一定先备份，见「铁律 4」。

### 任务 C：只改服务端代码

```bash
cp -a /opt/kb/service/app.py /opt/kb/backup/app.py.bak-$(date +%Y%m%d-%H%M%S)
# 上传新的 .py，然后
cd /opt/kb/service && rm -rf __pycache__ && \
  python3 -c "import ast,pathlib;ast.parse(pathlib.Path('app.py').read_text(encoding='utf-8'))" && \
  systemctl restart kb.service
```

改代码必须先做语法检查再重启，否则服务会因语法错误反复崩溃
（`RestartSec=3`，5 次内失败会被 systemd 放弃）。

---

## 五、五条铁律

### 铁律 1：装载后必须重载向量，否则向量路静默失效 ★最危险

`IndexStore` 把 `library → (chunk_ids, matrix)` 常驻在**服务进程内存**里。
`load_index.py` 是**另一个进程**，它写数据库、写 npz，然后只刷新自己的内存，
**对已在运行的 `kb.service` 没有任何影响**。

后果：`chunks.id` 是 `autoincrement`，替换同名库后 id 全部变成新值，
服务进程手里还是旧 id → 向量检索按旧 id 去数据库查，一条都查不到 →
**静默返回 0 条**，而关键词路正常，所以看起来「只是瘦了」。

本地最小复现已确认（替换前 id `[1,2]` → 替换后真实 id `[3,4]`）：

| 状态 | 向量检索结果 |
|---|---|
| 替换后未 reload | **空（0 条）** |
| reload 之后 | 正常命中新内容 |

所以每次装载后，二选一：
```bash
curl -s -X POST http://127.0.0.1:54142/kb/v1/reload   # 推荐，不需要停机
systemctl restart kb.service                          # 也可以，但会中断几秒
```

`/v1/reload` 是幂等的，只重读 npz，不改任何数据，随时可以调。

**验证方法**：reload 前后各查一次同义词，看 `health` 里的 `rows` 和实际命中：
```bash
curl -s http://127.0.0.1:54142/kb/health
# 期望 vectors.<新库>.rows == 你构建时的分块数
```

### 铁律 2：所有库必须同一套编码模型、同一维度

检索时所有库共用一个 `query_vector`，维度不同会直接 500。
`load_index.py` 的 `check_dim_consistency` 会拦住，**且检查发生在删除旧库之前**，
所以维度不符时会安全退出、原库不受损。

当前统一：`bge-small-zh-onnx`，**512 维**。

换模型 = 所有库都要重建，否则整个服务不可用。没有例外。

### 铁律 3：不要给调用方留 `auto_embed: false`

`auto_embed` 默认 `true`，服务端会自己把查询编码成向量。
设成 `false` 且不传 `query_vector` 时：
- `mode=semantic` → 直接 0 条
- `mode=hybrid` → 静默退化成只剩关键词，看着正常但语义没了

服务端会返回 `notice` 说明（跨库也已透传，2026-11-27 修复）。**看到 notice 就是出问题了**，
不要忽略。排查时优先确认调用方有没有乱传这个参数。

### 铁律 4：替换库之前先备份 sqlite

`drop_library` 在 autocommit 下**立即生效**（不在后面那个事务里）。
如果 drop 之后、写入完成之前的某一步失败（磁盘满、进程被杀），旧库就没了。

```bash
cp /opt/kb/data/kb.sqlite3 /opt/kb/backup/kb-before-<库名>-$(date +%Y%m%d-%H%M%S).sqlite3
```

注意备份文件很大（当前 448M），磁盘只剩 7.1G，**备份完记得清旧的**。

### 铁律 5：不要手改 sqlite，不要单独删 npz

- 直接 `UPDATE`/`DELETE` 数据库、不动 npz → 向量与正文错位，命中会张冠李戴
- 只删 `vectors/*.npz` 不 reload → 进程内存里仍有旧矩阵，查出来全是空
- 要动数据就走 `load_index.py`，它保证文档、分块、FTS、向量四者一致

---

## 六、验证清单（每次改完都跑）

```bash
# 1. 服务活着
curl -s http://127.0.0.1:54142/kb/health

# 2. 库数量与向量行数对不对
curl -s http://127.0.0.1:54142/kb/v1/libraries

# 3. 三路都还能查（关键词 / 语义 / 混合）
curl -s "http://127.0.0.1:54142/kb/v1/search?q=海缆打捞&top_k=1"
curl -s "http://127.0.0.1:54142/kb/v1/search?q=海缆打捞&mode=semantic&top_k=1"
curl -s "http://127.0.0.1:54142/kb/v1/search?q=海缆打捞&mode=keyword&top_k=1"

# 4. 响应里不该出现 notice

# 5. 对外可用（走 443）
curl -s -o /dev/null -w "%{http_code}\n" "https://huhuanjie.site/kb/v1/search?q=test&top_k=1"
```

**语义路专项验证**（最容易静默坏掉的一条）：

```bash
Q=$(python3 -c "import urllib.parse;print(urllib.parse.quote('怎么防止设备被雷劈'))")

# keyword 对照组：会误命中含「劈」的无关内容（路由汇总）
curl -s "http://127.0.0.1:54142/kb/v1/search?q=$Q&mode=keyword&top_k=2"

# semantic：必须命中「光缆的防雷与防强电」
curl -s "http://127.0.0.1:54142/kb/v1/search?q=$Q&mode=semantic&top_k=2"
```

这条问句字面上不含「防雷」，只有语义路能命中。实测基准（2026-11-27）：

| mode | 首条命中 |
|---|---|
| `keyword` | 十、路由汇总、环路风险与黑洞路由（纯字面巧合，与问题无关） |
| `semantic` | **十二、光缆的防雷与防强电** ✅ |

如果 `semantic` 返回 0 条、或首条退化成路由汇总，说明向量路坏了（通常是装载后没 reload）。

---

## 七、排障速查

| 现象 | 原因 | 处理 |
|---|---|---|
| 关键词有结果、语义 0 条 | 装载后没 reload | `POST /v1/reload` |
| 响应里有 `notice` | `auto_embed=false` 或没传向量 | 让调用方去掉该参数 |
| `health` 里某库 `rows` 与构建数不符 | 装载没完成或 npz 没落盘 | 重跑 `load_index.py` 再 reload |
| 装载报「向量维度不一致」 | 用了不同模型重建 | 全库统一模型重建；原库未受损 |
| 装载报「向量数与分块数不一致」 | index.json 与 npz 不是同一次构建的 | 重新构建，两个文件要成对 |
| 服务 500 | 维度混用或数据损坏 | 看 `journalctl -u kb.service -n 100` |
| 服务反复重启 | 代码语法错误 / 内存超限 | 先 `ast.parse` 查语法；`MemoryMax=1200M` |
| 页面 404 | 少了尾斜杠或路径不对 | 用 `/kb/`；接口是 `/kb/v1/...` |
| 磁盘满导致装载失败 | 只剩 7.1G，备份占 562M | 清 `/opt/kb/backup/` 旧备份 |

---

## 八、禁止操作

1. 不要在服务器上构建索引（内存不够，会挤垮线上服务）
2. 不要换编码模型而不重建全部库
3. 不要手改 `kb.sqlite3`
4. 不要只删 npz 不 reload
5. 不要跳过 reload 就宣布装载成功
6. 不要忽略响应里的 `notice`
7. 不要在没有备份的情况下替换已有库
8. 不要改动 `lianTongPartySchoolPdf` 的按页切分逻辑（详见 README：用页码不连续做边界会得到 1005 个假边界）

---

## 九、当前版本

| 组件 | 版本/状态 |
|---|---|
| 服务端代码 | 与仓库 `deploy/kb/` 一致，2026-11-27 已加跨库 notice 透传 |
| 编码模型 | `bge-small-zh-onnx`，量化 ONNX，512 维 |
| 服务端 Python | 3.12，依赖 numpy 2.4.4 / fastapi 0.165 / onnxruntime 1.32 / jieba |
| 本地构建 Python | `.codex-tmp\venv-dml`（Python 3.12.8，DirectML） |
