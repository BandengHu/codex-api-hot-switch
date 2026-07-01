# Codex SwitchGate

本地 Codex API 中转控制台。Codex 端只需要指向本服务的 OpenAI 兼容地址：

```text
http://127.0.0.1:8787/v1
```

## 启动

网页开发模式：

```powershell
npm exec --yes pnpm@10.21.0 -- install --frozen-lockfile
npm exec --yes pnpm@10.21.0 -- dev
```

桌面壳开发模式：

```powershell
npm exec --yes pnpm@10.21.0 -- desktop
```

Windows 安装包：

```powershell
npm exec --yes pnpm@10.21.0 -- desktop:build
```

当前机器的默认 `pnpm` 版本要求 Node 22+，如果仍使用 Node 20，请继续用上面的 `pnpm@10.21.0` 命令。

桌面壳会拉起或复用 `http://127.0.0.1:8787` 本地中转服务。关闭窗口时不会退出程序，而是隐藏到系统托盘；托盘菜单可以打开控制台、在浏览器打开、设置开机自启或退出。

## 数据

运行时配置保存在：

```text
.data/hot-switch-state.json
```

`.data/` 已加入 `.gitignore`，供应商密钥和请求日志不会进入版本管理。

打包后的桌面版会把运行数据放到系统用户数据目录，不会把开发机的 `.data/` 打进安装包。

## 已实现

- 控制台状态持久化：供应商、模型、映射、运行时策略、设置、请求日志
- 控制台 API：`/api/console`
- 配置导入/导出：`/api/console/import`、`/api/console/export`
- 供应商健康检查：`/api/providers/test`
- Electron 桌面壳：窗口、系统托盘、开机自启、启动/复用本地服务
- OpenAI 兼容入口：`/v1/models`、`/v1/chat/completions`、`/v1/responses`
- Codex 客户端模型列表：`/v1/models?client_version=...`
  - `自动`：按 SwitchGate 当前热切换配置转发
  - `模型(供应商)`：例如 `gpt-5.5(OpenAI 官方)`，命中后直连该供应商的该模型
  - Codex 桌面端下拉通过 `.codex/config.toml` 的 `model_catalog_json` 读取本地模型目录；在控制台同步模型目录后，需要重启 Codex 桌面端才会刷新下拉
- 热切换规则：优先模型映射，其次当前运行时策略
- OpenAI Responses 兼容协议：
  - `chat/completions` 自动转换为 Responses 请求
  - Responses 输入项、工具调用、`apply_patch` 自定义工具、文件/图片 content part 归一化
  - 强制重写 `model` 和 reasoning
  - 修复 Responses SSE 中缺失的 `call_id`、空 function arguments、缺失的 final message/reasoning/function output
  - 流式 chat completion 可从 Responses SSE 转回 `chat.completion.chunk`
- OpenAI Chat Completions 兼容协议：
  - Codex Responses 请求可转为 `/chat/completions` 上游
  - 支持 developer/system 合并、reasoning 方言映射、namespace 工具摊平
  - 支持 custom/freeform 工具代理，`apply_patch` 会拆成结构化 patch 工具并在响应时还原
  - Chat 非流式与流式响应可转回 Codex Responses
- Anthropic/Gemini 原生协议：
  - OpenAI Responses 与 chat/completions 请求统一归一化后再转原生协议
  - system/developer 指令、用户/助手历史、函数工具定义、工具调用历史、工具结果转换
  - data URL 图片转换，Anthropic 支持 URL 图片，Gemini 支持 fileUri 图片
  - 原生工具调用响应转回 OpenAI Responses 或 chat completion tool_calls
  - 原生流式响应转回 Responses SSE 或 `chat.completion.chunk`

## 当前边界

OpenAI Responses 与 OpenAI Chat Completions 是最完整主线，分别覆盖 Responses 原生上游和只支持 Chat Completions 的中转站。

Anthropic/Gemini 原生协议已支持函数工具与基础图片转换，但不会假装兼容无法忠实表达的结构。遇到 `previous_response_id`、非 function 内置工具、Gemini 非 data URL 文件、Anthropic 文件输入等结构，会返回明确错误并写入请求日志。
