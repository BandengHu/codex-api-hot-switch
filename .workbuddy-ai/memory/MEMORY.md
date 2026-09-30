# 项目长期记忆 — codex-api-hot-switch

## 项目定位
- Next.js 16 + React 19 + Electron 桌面控制台，本地 OpenAI 兼容中转（端口 8787）。
- 内置 WorkBuddy（腾讯 CodeBuddy）供应商；另有「国际版号池」独立页面。

## 构建 / 打包

### Electron 版
本机 WorkBuddy 环境跑 `next build` 有两个环境级坑，直接 `npm run build` 会假死或报错：
1. **safe-delete 垫片**：环境经 `NODE_OPTIONS=--require=.../node-language-shim.cjs` 注入安全删除垫片，
   `fs.unlink` 走 IPC 代理，且单轮次删除 >50 文件即中止。清空 `.next`（曾达 2.3G）会长时间零输出假死。
   → 构建时必须 **清空 NODE_OPTIONS**：
   `NODE_OPTIONS= NEXT_TELEMETRY_DISABLED=1 node node_modules/next/dist/bin/next build`
2. **沙箱拦截子进程创建**（`spawnSync cmd.exe` → `EBUSY`），构建需在非沙箱下运行。
3. 构建前若残留 `.next/lock`（上次被 kill 留下），会直接报 “Another next build process is already running”，需先删该锁。
4. `next build` 会自动改 `tsconfig.json` 的 `include`；若用 `NEXT_DIST_DIR` 试验，记得还原。

完整 Windows 安装包（`desktop:build` 手动等价步骤，每步清空 NODE_OPTIONS、非沙箱）：
1. `next build`
2. `node scripts/prepare-electron-build.cjs` ← 最慢（拷贝+递归裁剪 vendor，约 10 分钟）
3. `node scripts/generate-windows-icon.cjs`
4. `node node_modules/electron-builder/cli.js --win nsis`
- 产物：`dist/Codex SwitchGate Setup <version>.exe`（NSIS，163.97MB）+ `dist/win-unpacked/`
- 实测总耗时 ~13m50s。

### Tauri 版（分支 `tauri/experiment`）
1. `NODE_OPTIONS= node scripts/prepare-tauri-build.cjs`（~5m51s，资源 82MB，最长路径 227 字符）
2. `NODE_OPTIONS= cargo tauri build --bundles nsis`（~4m46s）
   - **必须 `dangerouslyDisableSandbox: true`**：`tauri-build` 用 `rc.exe` 编译 icon.ico 写临时 `.res` 被沙箱拦，
     报 `failed to compile icons/icon.ico into a Windows Resource file: 拒绝访问。 (os error 5)`
3. 产物：`tauri/src-tauri/target/release/bundle/nsis/Codex SwitchGate_0.2.12_x64-setup.exe` = **4.98 MiB**
   （`tauri/dist/` 被 .gitignore 忽略，安装包不入库）

## NFT「全项目被追踪」不阻塞打包（别重复排查）
- 不止加了 `outputFileTracingExcludes` 的路由。`providers/models`、`providers/test`、`models/test`、
  `console`、`codex-config`、`workbuddy-pool`、`[...path]`、`v1/[...path]`、`codex-desktop/model-whitelist`
  的 `*.nft.json` 都把整个项目根（含 `dist/**`、`AGENTS.md`、`app/**`）列进清单。
- **不用管**：`scripts/prepare-electron-build.cjs` 的 `tracedBuildArtifacts` 会在 `fs.cp(standaloneDir, ...)`
  **之前**把它们从 standalone 删掉。standalone 偏大只是磁盘占用。
- `outputFileTracingExcludes` 的 key 走 `picomatch(key,{dot:true,contains:true})`，是**子串**匹配，`"*"` 不可靠。

## 代码约定
- **动态路径的 fs 读取**用 `const { readFile } = await import("node:fs/promises")`，或加 `/* turbopackIgnore: true */`
  注释；否则 Next 的 NFT 会把整个项目卷进 `.next/standalone`。
  参考 `lib/server/workbuddy/task-pool-store.ts`、`lib/server/codex-session-sync/rollout.ts`。
- 若新路由确实触发全项目追踪，在 `next.config.mjs` 的 `outputFileTracingExcludes` 里加
  `runtimeFileSystemTraceExcludes`（同 `/api/codex-sessions`、`/api/wecom-bridge`）。

## 用户约束
- 改需求前先评估、经确认再动手；未经允许不要改动既有页面/逻辑。
- 国际版号池为**独立新增**，国内站原页面与逻辑保持不变。

## 国际版号池（国际站 www.workbuddy.ai）
- 后端：`lib/server/workbuddy/global-oauth.ts`、`global-account.ts`、`global-pool-store.ts`、`global-login-session.ts`。
- 路由：`app/api/workbuddy-global-pool/`（列表/导入）、`/[uid]`（启停删/余额/设为转发）、`/login`（发起+轮询）。
- 前端：`components/views/workbuddy-global-pool-view.tsx`、`workbuddy-global-pool-login-dialog.tsx`。
- **已接入转发链路**（3 个断点全打通）：
  1. `withWorkbuddyCredentials()` 按 `workbuddyRealmOfProvider(provider)` 分池：global → `readActiveGlobalPoolAccount()`，cn → `readActivePoolAccount()`。
  2. `workbuddyCatalogUrl()` 按 realm 分叉：global → `${origin}/v2/enterprises/personal/models`，cn → `${origin}/v3/config`。
  3. `workbuddyCatalogModels(payload, realm)` 国际站并入 `extraModels`（`deepseek-v4.1-flash`、`deepseek-v3`），
     `workbuddyCatalogError()` 校验信封 `code === 0`。
- 供应商：`PROVIDER_PRESETS` 有 `workbuddy-cn` / `workbuddy-global`（均 `openai-chat` + `workbuddyStaticHeaders()`
  + 模型级 `reasoningDialect: "workbuddy-effort"`，apiKey 留空由请求时注入）。
- 上游协议：**OpenAI Chat Completions**（`POST /v2/chat/completions`，只收 `stream: true`）；
  下游 `/v1/responses` 由 `chat-compatible.ts` 转 Chat 再转发。
- 号池语义：与国内站一致——**不自动轮转**，只手动「设为转发」；国际站无 `local` 账号。
- `WORKBUDDY_API_HOSTS` 含 `www.workbuddy.ai`/`workbuddy.ai`。

## Tauri 引导层外壳（分支 `tauri/experiment`，实验性）
Electron 架构下外壳常驻 200MB+ 无解（Clash Verge 十几兆是 Tauri + 系统 WebView2 的架构差异）。
用户决定直接做，**不考虑商用分发门槛**（纯自用）。已实测外壳内存 **31MB**、`/api/console` 200。

- 目录：`tauri/`（与 `electron/` 平级、互不干扰）、`scripts/prepare-tauri-build.cjs`。
- **关键前提**：宿主 Node **>= 22.5**。依据——`lib/server/codex-session-sync/sqlite.ts` **优先 `node:sqlite`**，
  `better-sqlite3` 只是 Node 20 兜底；包内 `better_sqlite3.node` 编译于 ABI 115（Electron 37 代），
  与 Electron 42 内置 Node（**24.16.0**，modules 146）和宿主 Node 22（127）都对不上 → **从未被加载过**。
  故只要宿主 Node >= 22.5，零原生依赖、不需 node-gyp / VS Build Tools。
- `src-tauri/src/app.rs` 要点：
  - `probe_node()` 扫 PATH + ProgramFiles/LOCALAPPDATA/fnm/Volta/nvm；`probe_node_version` 带 **4 秒超时轮询**。
  - `server_root()` **候选探测**：先 `<res>/resources/server`，再 `<res>/server`。**这是必须的**（见下「Windows 路径」）。
  - `start_server()` 先探活复用已在监听的实例；Windows `creation_flags(0x0800_0000)` 抑制黑框。
  - `attach_kill_on_close_job()` 用 Job Object + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 防孤儿，**句柄故意不关闭**。
  - 关窗改为 `hide()` 不进托盘常驻；托盘创建失败**不 panic**（记日志继续）。
  - `guide_log(level,msg)` → `logs/guide.log`；`debug_paths()` → JSON 路径诊断；`run()` 开头写 `logs/boot.log` 启动痕迹。
- `tauri.conf.json`：`frontendDist: ../ui`、`withGlobalTauri: true`、`csp: null`、
  `bundle.resources: ["../../.electron-shell/server/**/*"]`（实际配 `resources/server/**/*`）、nsis `installMode: currentUser`。
- **Tauri 的 resources 是真实文件，只需拷贝，无 asarUnpack 概念**。

### Windows `resource_dir()` 真相（踩过，务必记住）
`tauri-utils-2.10.0/src/platform.rs` 的 `resource_dir_from()` **只有 linux / macOS / iOS 三个分支，
没有 Windows 生产分支**；Windows 走 `cfg!(target_os="windows")` 唯一分支，**无条件返回 `exe_dir`（exe 同级目录）**。
而 `bundle.resources` 的 `resources/server/**/*` 会在安装目录下**原样保留 `resources\` 这一层**
→ 正确路径是 `<install>\resources\server\server.js`，不是 `<install>\server\server.js`。
（用户实测报错 `找不到 server.js：...\Codex Switch Gate\server` 即此因。）

### NSIS 配置
- 中文界面：`bundle.windows.nsis.languages = ["SimpChinese", "English"]`，
  复用 tauri-bundler 内置 `.../windows/nsis/languages/SimpChinese.nsh`（官方完整译文，**不用自写翻译**）。
  `displayLanguageSelector: false` → 直接中文不弹选择框。
  验证：看 `target/release/nsis/x64/installer.nsi` 的 `!insertmacro MUI_LANGUAGE "SimpChinese"`。
- **`NsisConfig` 是 `deny_unknown_fields`**：任何未知字段让整个对象校验失败，报错只含糊说
  `not valid under any of the schemas listed in the 'anyOf' keyword`，**不指出具体字段**。
  → 改动前先用 `tauri-cli-*/config.schema.json` 的 `definitions.NsisConfig` 预校验。
- **`compression` 合法值全小写**：`zlib`/`bzip2`/`lzma`/`none`。PascalCase 的 `"Lzma"` 非法。
- 合法字段全集：`template`/`headerImage`/`sidebarImage`/`installerIcon`/`uninstallerIcon`/`uninstallerHeaderImage`/
  `installMode`/`languages`/`customLanguageFiles`/`displayLanguageSelector`/`compression`/`startMenuFolder`/
  `installerHooks`/`minimumWebview2Version`。**没有 `shortcutName`**。

### 坑 ①：`[lib]` 必须配 `src/lib.rs`
`Cargo.toml` 声明 `[lib]` 就必须有 `src/lib.rs`；已改成 `lib.rs` 声明 `mod app` + `main.rs` 薄调用。

### 坑 ②：schemars 0.8.22 E0107（**别再走手改 lock 的死路**）
`tauri-build 2.7.0 → tauri-utils 2.10 → schemars ^0.8.22`；schemars 在 `preserve_order` feature 下
源码写 `indexmap::IndexMap<K, V>`（旧两泛型 API），但解析到 indexmap 1.9.3 的三泛型定义 → E0107。
- `preserve_order` 由 `tauri-plugin → json-patch` 传递启用，**下游关不掉**；降级 schemars 不行；
  `[patch.crates-io] indexmap-old = {...}` 报 "patches must point to different sources"。
- **解法**：`tauri/vendor-patches/schemars/`（源码副本，791K，已入库），把 `Map`/`MapEntry` 两个
  `preserve_order` 分支退化为 `BTreeMap`、`preserve_order = []`，配 `[patch.crates-io] schemars = { path = ... }`。
- 反例：给 `Map` 补第三泛型 `RandomState` → 引发 `Map::new()` 不存在等 4 个新错误。

### 坑 ③：超长路径阻塞 NSIS
pnpm 把 peer 依赖校验和嵌进目录名（`.pnpm/next@16.2.6_@babel+core@7.2_40a7effce8bcad24669d45809ebe449e`），
实测 **146 个条目**绝对路径超 Windows 260 字符上限（最长 **291**），`makensis` 打不开文件即整体 abort
（`File: failed opening file ...` + `Error in script "installer.nsi" on line 11057 -- aborting`）。
→ `prunePnpmStore` 整删 `.pnpm` + `assertNoLongPaths(root, 250)` 护栏。
**`.pnpm` 对 Tauri 链路冗余**：Next standalone 已把依赖 bundle 进 `.next/server/chunks`；
实测移走后 16 个 API 路由全 200/405、0 个 5xx。
**`pruneVendor` 顺序**：先 `pruneDuplicatedTopLevelVendorPackages`（依赖 `.pnpm` 存在），再 `prunePnpmStore`。

### 已知问题：孤儿 node 进程（未能归因）
`AssignProcessToJobObject` 加 `GetLastError` 诊断后无失败输出；panic hook 无记录；进程稳定存活 35s+。
本环境 bash 工具会回收自己启动的子进程，导致「外壳提前退出」无法与「测试工具杀了它」区分
→ **待正常环境复现**。备选方案见 `tauri/README.md`。

### 尚未做
- 前端适配层：`lib/desktop-open-external.ts`、`lib/desktop-directory-picker.ts` 及 5 个
  `declare global { window.codexHotSwitchFloating }` 仍只认 Electron 桥，需加 Tauri 分派
  （建议在 lib 里加适配层，保持 bridge 形状不变）。
- 孤儿 node 进程定位。

## 两版数据目录一致（重要）
Electron 的 `electron/server-runtime-config.cjs` 与 Rust 的 `default_data_dir()` 都解析到
`%APPDATA%\codex-api-hot-switch\data` → Tauri 版**直接复用 Electron 数据**
（`hot-switch-state.json` / `workbuddy-pool` / `workbuddy-global-pool` 均在），无需迁移。

## 安装目录现状
- Electron 版：`C:\Program Files\Codex Switch Gate`（**系统级 perMachine**），控制面板或目录内
  `Uninstall Codex Switch Gate.exe` 卸载。
- Tauri 版：`%LOCALAPPDATA%\Codex SwitchGate`（**用户级 currentUser**），两者不同目录、可共存。
- 用户已选择：**用 Tauri 版替代 Electron 版**（同一用户目录思路），确认 Tauri 版可用后卸掉 Electron 版。

## 包体积（已做，写进 scripts/prepare-electron-build.cjs）
- `pruneElectronLocales()`：Electron 语言包只留 `en-US.pak`/`zh-CN.pak`（48MB→2MB）。就地裁，幂等。
  **这版 electron-builder（26.x）不支持 `electronLanguages` 配置项**，只能脚本裁。
- `pruneRedundantVendorStaticTools(vendorDir)`：删 `vendor/.pnpm/{ffmpeg,ffprobe}-static@*`。
  依据：全项目只有 `integrations/codexbridge` 用，且它 `createRequire` 从自己 `node_modules` 解析。
  保守设计：只有确认 codexbridge 侧 `ffprobe.exe` 存在时才删。
- 效果：安装包 **163.97MB → 141.31MB（-13.8%）**。
- `LICENSES.chromium.html`（20MB 纯文本）默认**保留**——删它有 Chromium 许可合规风险。

## 桌面端外链：统一走系统浏览器
- `electron/main.cjs` 的 `codex-hot-switch-open-external`（校验来源 + 只放行 http/https → `shell.openExternal`）；
  mainWindow 另加 `setWindowOpenHandler` 兜底。
- `electron/floating-preload.cjs` 暴露 `openExternal`；前端统一用 `lib/desktop-open-external.ts` 的
  `openExternalUrl()`（无桥时退化成 `window.open`）。
- 两个 WorkBuddy 登录弹窗拿到授权 URL 后**自动**打开系统浏览器。

## UI 约定（踩过的坑）
- `components/ui/sonner.tsx` 加了 `closeButton`；`dismissible` **不是 Toaster 的 prop**（是单条 toast 选项），加了会 TS2322。
- `app/globals.css` 覆盖 `[data-sonner-toast]` 的 `user-select: text` 让报错可复制，`[data-close-button]` 绝对定位右上角。
- `components/ui/table.tsx` 的 `Table` 有可选 `containerClassName`。日志表格 10 列 + 20 行很高，
  横向滚动条会被挤到折叠线以下，`logs-view.tsx` 用 `max-h-[calc(100dvh-21rem)] overflow-y-auto`
  + `TableHeader sticky top-0 z-10 bg-card` 解决。

## 环境特性（恒定，别再踩）
- **沙箱内 `spawn node` / `cmd /c mklink` 报 `EBUSY`**；`reg.exe` 被程序黑名单拦；
  GUI 长驻进程会被 bash 工具回收；`/tmp` 与 `-o` 落盘写不了。
- `fs.symlinkSync(target, link, "junction")` 可用（唯一可靠的链接手段，用 node 脚本调）。
- **教训：长任务必须 `TaskOutput` 等到 completed 再跑依赖它的下一步**
  （曾在资源准备未完成时启动打包，cargo 遍历撞上正在被删的目录 → `os error 3 系统找不到指定的路径`）。
