# Tauri 引导层外壳（实验）

与 `electron/` 平级、完全隔离的独立外壳，**Electron 链路不受任何影响**。

## 为什么存在

Electron 外壳把整个 Chromium 打进包（安装包 141MB，运行内存 200MB+），
而 Clash Verge 这类 Tauri 应用只要十几 MB。差异不是配置能追上的——
Tauri 用的是**系统 WebView2**，Electron 自带 Chromium。

## 关键前提（实测确认）

**宿主 Node 可以直接跑中转服务，且不需要任何原生编译。**

- `lib/server/codex-session-sync/sqlite.ts` **优先用 Node 内置的 `node:sqlite`**，
  `better-sqlite3` 只是 Node 20 的兜底。
- 只要宿主 Node **>= 22.5**（`node:sqlite` 引入版本），就零原生依赖，
  不需要 node-gyp / VS Build Tools。
- 包内那份 `better_sqlite3.node` 编译于 NODE_MODULE_VERSION 115（Electron 37 代 ABI），
  与 Electron 42（146）和 Node 22（127）都对不上——说明它从未被真正加载过，
  是个睡着的坑，不是活的问题。

实测：`cd .next/standalone && node server.js` → `✓ Ready`，`/api/console` 返回 200。

## 目录结构

```
tauri/
├─ ui/index.html              引导界面：环境自检 → 一键启动 → 跳转控制台
├─ vendor-patches/schemars/   上游补丁（见下）
└─ src-tauri/
   ├─ Cargo.toml
   ├─ tauri.conf.json
   └─ src/
      ├─ app.rs               Node 探测 / 版本校验 / 服务拉起 / 孤儿进程防护
      ├─ lib.rs
      └─ main.rs
```

## 已实现

- **Node 探测**：PATH 裸名 + ProgramFiles / nvm / fnm / Volta 常见落点
- **版本闸门**：低于 22.5 明确报错（否则会回退到 ABI 不兼容的 better-sqlite3）
- **服务拉起**：`node server.js`，cwd 指向 server 根，NODE_PATH 拼 vendor + `.pnpm`
- **端口复用**：8787 已在监听时不重复拉起，直接标记为「已连接」
- **孤儿进程防护**：Windows Job Object（`KILL_ON_JOB_CLOSE`）
- **引导界面**：检测 → 启动 → 轮询健康检查 → 自动跳转

## 已知问题

### 1. 孤儿 node 进程 —— 未能在本机验证

现象：外壳进程消失后，被它拉起的 node 仍在监听 8787。

- `AssignProcessToJobObject` 返回成功，但 Job Object 没拦住子进程
- **重要**：本机 WorkBuddy 的 bash 工具会回收自己启动的子进程，
  导致「外壳是否真的提前退出」无法区分于「测试工具把它杀了」
  （用 `( ... &)` 脱离 shell 也无效）
- 本环境还限制子进程创建、启用了程序黑名单，验证结果不可信
- **需要在正常环境复现后再判断**：如果确实是 Job Object 失效，
  备选方案是让外壳定时 `ServerStatus` 探活 + 退出时显式 kill，
  或改用 node 侧自守护（父进程 PID 轮询）

### 2. 上游依赖补丁：schemars 0.8.22

`tauri-build 2.7.0 → tauri-utils 2.10 → schemars 0.8.22`，在 Rust 1.94 下编译失败：

```
error[E0107]: struct takes 3 generic arguments but 2 supplied
  --> schemars-0.8.22/src/lib.rs:12
  pub type Map<K, V> = indexmap::IndexMap<K, V>;
```

根因：`preserve_order` feature（由 `tauri-plugin → json-patch` 启用，下游关不掉）
的代码按**旧 indexmap 两泛型 API** 写，但解析到 indexmap 1.9.3 的三泛型定义。
实测 indexmap 1.6~1.9 全系都挂。

`vendor-patches/schemars/` 是本地修补版，改动两处：
- `Map` / `MapEntry` 统一退化为 `BTreeMap` / `btree_map::Entry`（放弃保序，对构建无影响）
- `preserve_order = []`（不再级联 `indexmap` feature，避免编译 `json_schema_impls/indexmap.rs`）

## 构建

```bash
# 1. 准备 Next standalone 产物（复用现有构建）
NODE_OPTIONS= NEXT_TELEMETRY_DISABLED=1 node node_modules/next/dist/bin/next build

# 2. 准备 Tauri 资源
NODE_OPTIONS= node scripts/prepare-tauri-build.cjs

# 3. 编译（开发验证）
cd tauri/src-tauri && cargo build

# 4. 打包安装器（需要 tauri-cli，本机尚未安装）
cd tauri/src-tauri && cargo tauri build
```

## 体积 / 内存对比（实测）

| | Electron 外壳 | Tauri 外壳（debug） |
|---|---|---|
| 外壳本体 | 约 172MB（含 Chromium） | 19MB（debug 未优化） |
| 空闲内存 | 200MB+ | **31MB** |

注意 debug 版 19MB 未做优化；release + LTO 会显著更小，
且 Tauri 不需要 Chromium 那 ~120MB。
