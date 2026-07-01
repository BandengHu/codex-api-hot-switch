const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const { execFile, spawn } = require("node:child_process")
const WebSocket = require("ws")

const DEFAULT_DEBUG_PORT = 9229
const DEFAULT_RELAY_BASE_URL = "http://127.0.0.1:8787"
const CDP_TIMEOUT_MS = 5000
const INJECT_RETRY_COUNT = 20
const INJECT_RETRY_DELAY_MS = 500

function numberArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = Number(process.argv[index + 1])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function stringArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = String(process.argv[index + 1] || "").trim()
  return value || fallback
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function exists(filePath) {
  try {
    await fs.stat(filePath)
    return true
  } catch {
    return false
  }
}

function windowsAppsRoot() {
  return path.join(process.env.ProgramFiles || "C:\\Program Files", "WindowsApps")
}

function parseVersionFromInstallPath(filePath) {
  const match = filePath.match(/OpenAI\.Codex_(.+?)_x64__/i)
  return match?.[1] || ""
}

async function latestCodexInstallPath() {
  let entries = []
  try {
    entries = await fs.readdir(windowsAppsRoot())
  } catch {
    return ""
  }
  const candidates = entries
    .filter((name) => /^OpenAI\.Codex(?:Beta)?_.+_x64__/i.test(name))
    .map((name) => path.join(windowsAppsRoot(), name))
    .sort((a, b) =>
      parseVersionFromInstallPath(b).localeCompare(
        parseVersionFromInstallPath(a),
        undefined,
        { numeric: true },
      ),
    )

  for (const candidate of candidates) {
    const exe = path.join(candidate, "app", "Codex.exe")
    if (await exists(exe)) return candidate
  }
  return candidates[0] || ""
}

function codexExeFromInstall(installPath) {
  return installPath ? path.join(installPath, "app", "Codex.exe") : ""
}

function packagedAppUserModelId(installPath) {
  const packageName = path.basename(installPath || "")
  const match = packageName.match(/^(OpenAI\.Codex(?:Beta)?)_[^_]+_x64__([^_]+)$/i)
  return match ? `${match[1]}_${match[2]}!App` : ""
}

function commandLineArguments(args) {
  return args
    .map((arg) => /\s/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg)
    .join(" ")
}

function queryCodexProcessCommandLines() {
  if (process.platform !== "win32") return Promise.resolve([])
  const script = "Get-CimInstance Win32_Process -Filter \"name = 'Codex.exe'\" | Select-Object -ExpandProperty CommandLine | ConvertTo-Json -Compress"
  return new Promise((resolve) => {
    execFile("pwsh", ["-NoLogo", "-NoProfile", "-Command", script], { windowsHide: true, timeout: CDP_TIMEOUT_MS }, (_error, stdout) => {
      try {
        const parsed = JSON.parse(String(stdout || "[]"))
        resolve(Array.isArray(parsed) ? parsed.filter(Boolean) : parsed ? [String(parsed)] : [])
      } catch {
        resolve([])
      }
    })
  })
}

function queryCodexProcesses() {
  if (process.platform !== "win32") return Promise.resolve([])
  const script = "Get-CimInstance Win32_Process -Filter \"name = 'Codex.exe' OR name = 'codex.exe'\" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"
  return new Promise((resolve) => {
    execFile("pwsh", ["-NoLogo", "-NoProfile", "-Command", script], { windowsHide: true, timeout: CDP_TIMEOUT_MS }, (_error, stdout) => {
      try {
        const parsed = JSON.parse(String(stdout || "[]"))
        const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
        resolve(
          rows
            .map((row) => ({
              processId: Number(row.ProcessId) || 0,
              executablePath: String(row.ExecutablePath || ""),
              commandLine: String(row.CommandLine || ""),
            }))
            .filter((row) => row.processId > 0),
        )
      } catch {
        resolve([])
      }
    })
  })
}

function isDesktopCodexProcess(processInfo) {
  const haystack = `${processInfo.executablePath || ""} ${processInfo.commandLine || ""}`.toLowerCase()
  return haystack.includes("openai.codex") && haystack.includes("\\app\\codex.exe")
}

function isCodexAppServerProcess(processInfo) {
  const haystack = `${processInfo.executablePath || ""} ${processInfo.commandLine || ""}`.toLowerCase()
  return haystack.includes("openai.codex") && haystack.includes("\\app\\resources\\codex.exe") && haystack.includes(" app-server")
}

function isDesktopCodexMainProcess(processInfo) {
  const line = String(processInfo.commandLine || "").toLowerCase()
  return isDesktopCodexProcess(processInfo) && !line.includes(" --type=")
}

function isCodexRestartBlockingProcess(processInfo) {
  const line = String(processInfo.commandLine || "").toLowerCase()
  if (isCodexAppServerProcess(processInfo)) return true
  return isDesktopCodexProcess(processInfo) && !line.includes("--type=crashpad-handler")
}

async function codexMainProcessAlreadyRunning() {
  const processes = await queryCodexProcesses()
  return processes.some((processInfo) => {
    const lower = String(processInfo.commandLine || "").toLowerCase()
    return isDesktopCodexMainProcess(processInfo) && !lower.includes("--remote-debugging-port")
  })
}

async function desktopCodexProcessCount() {
  const processes = await queryCodexProcesses()
  return processes.filter(isDesktopCodexProcess).length
}

async function codexRestartBlockingProcessCount() {
  const processes = await queryCodexProcesses()
  return processes.filter(isCodexRestartBlockingProcess).length
}

function requestCodexDesktopClose() {
  if (process.platform !== "win32") return Promise.resolve(0)
  const script = `
$ErrorActionPreference = "Stop"
$targets = Get-Process -Name Codex -ErrorAction SilentlyContinue |
  Where-Object {
    $path = ([string]$_.Path).ToLower()
    $path.Contains("\\windowsapps\\openai.codex") -and
      $path.EndsWith("\\app\\codex.exe") -and
      $_.MainWindowHandle -ne 0
  }
$count = @($targets).Count
foreach ($target in @($targets)) {
  [void]$target.CloseMainWindow()
}
[Console]::Out.Write($count)
`
  return new Promise((resolve, reject) => {
    execFile("pwsh", ["-NoLogo", "-NoProfile", "-Command", script], { windowsHide: true, timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()))
        return
      }
      resolve(Number(String(stdout).trim()) || 0)
    })
  })
}

async function waitForCodexDesktopExit() {
  for (let index = 0; index < 80; index += 1) {
    if ((await codexRestartBlockingProcessCount()) === 0) return true
    await sleep(250)
  }
  return false
}

function activatePackagedApp(appUserModelId, args) {
  const argumentText = commandLineArguments(args)
  const script = `
$ErrorActionPreference = "Stop"
$code = @"
using System;
using System.Runtime.InteropServices;
[Flags]
public enum ActivateOptions { None = 0, DesignMode = 1, NoErrorUI = 2, NoSplashScreen = 4 }
[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
public class ApplicationActivationManager {}
[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("2e941141-7f97-4756-ba1d-9decde894a3d")]
public interface IApplicationActivationManager {
  [PreserveSig]
  int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [MarshalAs(UnmanagedType.LPWStr)] string arguments, ActivateOptions options, out uint processId);
  [PreserveSig]
  int ActivateForFile([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, IntPtr itemArray, [MarshalAs(UnmanagedType.LPWStr)] string verb, out uint processId);
  [PreserveSig]
  int ActivateForProtocol([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, IntPtr itemArray, out uint processId);
}
public static class CodexSwitchGateAppActivator {
  public static uint Activate(string appUserModelId, string arguments) {
    var manager = (IApplicationActivationManager)new ApplicationActivationManager();
    uint processId;
    int hr = manager.ActivateApplication(appUserModelId, arguments, ActivateOptions.None, out processId);
    if (hr != 0) Marshal.ThrowExceptionForHR(hr);
    return processId;
  }
}
"@
Add-Type -TypeDefinition $code
$pidValue = [CodexSwitchGateAppActivator]::Activate(${JSON.stringify(appUserModelId)}, ${JSON.stringify(argumentText)})
[Console]::Out.Write($pidValue)
`
  return new Promise((resolve, reject) => {
    execFile("pwsh", ["-NoLogo", "-NoProfile", "-Command", script], { windowsHide: true, timeout: CDP_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()))
        return
      }
      const processId = Number(String(stdout).trim()) || 0
      resolve(processId)
    })
  })
}

async function queryJson(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CDP_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

async function listTargets(debugPort) {
  const urls = [
    `http://127.0.0.1:${debugPort}/json`,
    `http://[::1]:${debugPort}/json`,
  ]
  const errors = []
  for (const url of urls) {
    try {
      const targets = await queryJson(url)
      return Array.isArray(targets) ? targets : []
    } catch (error) {
      errors.push(`${url}: ${error.message || String(error)}`)
    }
  }
  const err = new Error(errors.join("; ") || "CDP 端口不可访问")
  err.code = "CDP_UNREACHABLE"
  throw err
}

function isInjectablePage(target) {
  return target?.type === "page" && typeof target.webSocketDebuggerUrl === "string" && target.webSocketDebuggerUrl
}

function isCodexPage(target) {
  const haystack = `${target?.title || ""} ${target?.url || ""}`.toLowerCase()
  return haystack.includes("codex")
}

function pickCodexTarget(targets) {
  return targets.filter(isInjectablePage).find(isCodexPage) || null
}

class CdpSession {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl
    this.nextId = 1
    this.pending = new Map()
  }

  async open() {
    this.ws = new WebSocket(this.webSocketUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP WebSocket 连接超时")), CDP_TIMEOUT_MS)
      this.ws.once("open", () => {
        clearTimeout(timer)
        resolve()
      })
      this.ws.once("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    this.ws.on("message", (data) => {
      let message
      try {
        message = JSON.parse(String(data))
      } catch {
        return
      }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)))
        else pending.resolve(message)
      }
    })
  }

  async command(method, params = {}) {
    const id = this.nextId++
    const payload = JSON.stringify({ id, method, params })
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 执行超时`))
      }, CDP_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
    })
    this.ws.send(payload)
    return result
  }

  close() {
    try {
      this.ws?.close()
    } catch {
    }
  }
}

function injectionScript(catalog) {
  const embeddedCatalog = normalizeCatalog(catalog)
  return `
(() => {
  const injectedCatalog = ${JSON.stringify(embeddedCatalog)};
  const state = window.__codexSwitchGateModelWhitelist || {
    installed: false,
    catalogLoadedAt: 0,
    catalogPromise: null,
    catalog: { status: "loading", model: "", default_model: "", provider_name: "codex_switchgate", models: [], labels: {} },
    modelListRequestIds: new Set(),
    patchFailures: [],
  };
  state.catalog = injectedCatalog;
  state.catalogLoadedAt = Date.now();
  state.catalogPromise = null;
  state.appServerRequestPatchInstalled = false;
  if (!(state.modelListRequestIds instanceof Set)) state.modelListRequestIds = new Set();
  state.modelListRequestIds.add("__codex_switchgate_model_list_request_sentinel__");
  state.patchFailures = [];
  window.__codexSwitchGateModelWhitelist = state;

  function normalizeModelEntry(value) {
    if (typeof value === "string") {
      const id = value.trim();
      return id ? { id } : null;
    }
    if (!value || typeof value !== "object") return null;
    const id = String(value.model || value.id || value.slug || "").trim();
    if (!id) return null;
    return { id };
  }

  function modelEntries() {
    const seen = new Set();
    const entries = [];
    const add = (entry) => {
      const normalized = normalizeModelEntry(entry);
      if (!normalized || seen.has(normalized.id)) return;
      seen.add(normalized.id);
      entries.push(normalized);
    };
    if (Array.isArray(state.catalog.models)) state.catalog.models.forEach(add);
    add(state.catalog.default_model);
    add(state.catalog.model);
    return entries;
  }

  function modelNames() {
    return modelEntries().map((entry) => entry.id);
  }

  function modelInfo(modelName) {
    return modelEntries().find((entry) => entry.id === modelName) || { id: modelName };
  }

  async function loadCatalog() {
    return state.catalog;
  }

  function reasoningEfforts() {
    return ["low", "medium", "high", "xhigh"].map((reasoningEffort) => ({
      reasoningEffort,
      description: reasoningEffort + " effort",
    }));
  }

  function descriptor(modelName) {
    const info = modelInfo(modelName);
    return {
      model: info.id,
      id: info.id,
      slug: info.id,
      name: info.id,
      displayName: info.id,
      display_name: info.id,
      description: info.id,
      label: info.id,
      title: info.id,
      owned_by: "codex_switchgate",
      hidden: false,
      isDefault: (state.catalog.default_model || state.catalog.model) === info.id,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: reasoningEfforts(),
    };
  }

  function modelArrayLooksPatchable(value, allowEmpty = false) {
    return Array.isArray(value)
      && (allowEmpty || value.length > 0)
      && value.every((item) => item && typeof item === "object" && typeof item.model === "string");
  }

  function stringArrayLooksPatchable(value) {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
  }

  function patchModelNameArray(models) {
    if (!stringArrayLooksPatchable(models)) return false;
    const names = modelNames();
    if (!names.length) return false;
    let changed = false;
    names.forEach((name) => {
      if (!models.includes(name)) {
        models.push(name);
        changed = true;
      }
    });
    return changed;
  }

  function patchModelArray(models, allowEmpty = false) {
    if (!modelArrayLooksPatchable(models, allowEmpty)) return false;
    const names = modelNames();
    if (!names.length) return false;
    let changed = false;
    const existing = new Map(models.map((item) => [item.model, item]));
    models.forEach((item) => {
      if (names.includes(item.model) && item.hidden !== false) {
        item.hidden = false;
        changed = true;
      }
    });
    names.forEach((name) => {
      if (!existing.has(name)) {
        models.push(descriptor(name));
        changed = true;
      }
    });
    return changed;
  }

  function patchModelContainer(value) {
    if (!value || typeof value !== "object") return false;
    let changed = false;
    if (patchModelArray(value.models, "defaultModel" in value || "availableModels" in value)) changed = true;
    if (patchModelNameArray(value.models)) changed = true;
    if (patchModelArray(value.data)) changed = true;
    if (patchModelArray(value.result)) changed = true;
    if (patchModelArray(value.pages?.[0]?.data)) changed = true;
    if (patchModelArray(value.result?.data)) changed = true;
    if (patchModelArray(value.result?.models)) changed = true;
    if (patchModelArray(value.message?.result?.data)) changed = true;
    if (patchModelArray(value.message?.result?.models)) changed = true;
    const names = modelNames();
    for (const key of ["availableModels", "available_models"]) {
      const target = value[key];
      if (target instanceof Set) {
        names.forEach((name) => {
          if (!target.has(name)) {
            target.add(name);
            changed = true;
          }
        });
      } else if (Array.isArray(target)) {
        names.forEach((name) => {
          if (!target.includes(name)) {
            target.push(name);
            changed = true;
          }
        });
      }
    }
    for (const key of ["hiddenModels", "hidden_models"]) {
      if (Array.isArray(value[key])) {
        const before = value[key].length;
        value[key] = value[key].filter((name) => !names.includes(name));
        if (value[key].length !== before) changed = true;
      }
    }
    if (value.defaultModel == null && names.length > 0) {
      value.defaultModel = descriptor(names[0]);
      changed = true;
    } else if (typeof value.defaultModel === "string" && names.includes(value.defaultModel) && value.model == null) {
      value.model = value.defaultModel;
      changed = true;
    }
    if (value.default_model == null && names.length > 0) {
      value.default_model = names[0];
      changed = true;
    }
    return changed;
  }

  function patchStatsigDynamicConfig(config) {
    const names = modelNames();
    const value = config?.value;
    if (!names.length || !value || typeof value !== "object") return config;
    const available = Array.isArray(value.available_models) ? [...value.available_models] : [];
    let changed = false;
    names.forEach((name) => {
      if (!available.includes(name)) {
        available.push(name);
        changed = true;
      }
    });
    const nextValue = { ...value, available_models: available, default_model: names[0] || value.default_model };
    if (!changed && nextValue.default_model === value.default_model) return config;
    try { config.value = nextValue; } catch { return { ...config, value: nextValue }; }
    return config;
  }

  function statsigClients() {
    const root = window.__STATSIG__ || globalThis.__STATSIG__;
    if (!root || typeof root !== "object") return [];
    const clients = [root.firstInstance, typeof root.instance === "function" ? root.instance() : null];
    if (root.instances && typeof root.instances === "object") clients.push(...Object.values(root.instances));
    return clients.filter((client, index, array) => client && typeof client === "object" && array.indexOf(client) === index);
  }

  function patchStatsig() {
    statsigClients().forEach((client) => {
      if (typeof client.getDynamicConfig !== "function") return;
      if (!client.__codexSwitchGateModelWhitelistPatched) {
        const original = client.getDynamicConfig.bind(client);
        client.getDynamicConfig = (name, options) => patchStatsigDynamicConfig(original(name, options));
        client.__codexSwitchGateModelWhitelistPatched = true;
      }
      try { patchStatsigDynamicConfig(client.getDynamicConfig("107580212", { disableExposureLog: true })); } catch {}
    });
  }

  function modelLabel(modelName) {
    const labels = state.catalog?.labels || {};
    const label = typeof labels[modelName] === "string" ? labels[modelName].trim() : "";
    return label || modelName;
  }

  function replaceModelIdsWithLabels(text) {
    let next = text;
    const names = modelNames().slice().sort((a, b) => b.length - a.length);
    for (const name of names) {
      const label = modelLabel(name);
      if (label && label !== name && next.includes(name)) {
        next = next.split(name).join(label);
      }
    }
    return next;
  }

  function shouldSkipTextParent(parent) {
    if (!parent || parent.nodeType !== Node.ELEMENT_NODE) return true;
    const tag = parent.tagName;
    return ["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "SELECT", "OPTION"].includes(tag) || parent.isContentEditable;
  }

  function patchVisibleModelLabels() {
    if (!modelNames().length) return false;
    let changed = false;
    const selector = "[role=menu], [role=dialog], [role=listbox], [data-radix-popper-content-wrapper]";
    const roots = Array.from(document.querySelectorAll(selector)).filter(Boolean);
    for (const root of roots.slice(0, 80)) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let visited = 0;
      while (visited < 500) {
        const node = walker.nextNode();
        if (!node) break;
        visited += 1;
        if (shouldSkipTextParent(node.parentElement)) continue;
        const value = node.nodeValue || "";
        const next = replaceModelIdsWithLabels(value);
        if (next !== value) {
          node.nodeValue = next;
          changed = true;
        }
      }
    }
    return changed;
  }

  function requestIdString(value) {
    return value == null ? "" : String(value);
  }

  function rememberModelListRequest(request) {
    const requestId = requestIdString(request?.id ?? request?.requestId);
    if (requestId) state.modelListRequestIds.add(requestId);
  }

  function consumeModelListRequestId(data, message) {
    const candidates = [
      data?.id,
      data?.requestId,
      message?.id,
      message?.requestId,
    ].map(requestIdString).filter(Boolean);
    const requestId = candidates.find((id) => state.modelListRequestIds.has(id));
    if (!requestId) return false;
    state.modelListRequestIds.delete(requestId);
    return true;
  }

  function patchMcpModelResponseData(data) {
    if (data?.type !== "mcp-response") return false;
    const message = data.message || data.response;
    if (!consumeModelListRequestId(data, message)) return false;
    return patchModelContainer(data) || patchModelContainer(message) || patchModelContainer(message?.result) || patchModelContainer(message?.result?.data);
  }

  function installAppServerMessagePatch() {
    if (state.messagePatchInstalled) return;
    state.messagePatchInstalled = true;
    const originalDispatchEvent = window.dispatchEvent;
    window.dispatchEvent = function codexSwitchGateDispatchEvent(event) {
      try {
        const detail = event?.detail;
        const request = detail?.request;
        if (event?.type === "codex-message-from-view" && detail?.type === "mcp-request" && request?.method === "model/list") {
          request.params = { ...(request.params || {}), includeHidden: true };
          rememberModelListRequest(request);
        }
        if (event?.type === "message") patchMcpModelResponseData(event.data);
      } catch (error) {
        state.patchFailures.push(String(error?.stack || error));
      }
      return originalDispatchEvent.call(this, event);
    };
    window.addEventListener("message", (event) => {
      try { patchMcpModelResponseData(event?.data); } catch (error) { state.patchFailures.push(String(error?.stack || error)); }
    }, true);
  }

  function assetUrl(namePart) {
    const urls = [
      ...Array.from(document.scripts || []).map((script) => script.src),
      ...Array.from(document.querySelectorAll("link[href]") || []).map((link) => link.href),
      ...performance.getEntriesByType("resource").map((entry) => entry.name),
    ].filter(Boolean);
    return urls.find((url) => url.includes("/assets/") && url.includes(namePart) && url.split("?")[0].endsWith(".js")) || "";
  }

  async function loadAppModule(namePart) {
    state.modulePromises = state.modulePromises || new Map();
    if (!state.modulePromises.has(namePart)) {
      state.modulePromises.set(namePart, Promise.resolve().then(async () => {
        const url = assetUrl(namePart);
        if (!url) throw new Error("未找到 Codex App asset: " + namePart);
        return await import(url);
      }).catch((error) => {
        state.modulePromises.delete(namePart);
        throw error;
      }));
    }
    return await state.modulePromises.get(namePart);
  }

  function appServerMethod(method, params) {
    if (method === "send-cli-request-for-host" && params?.method) return String(params.method);
    return String(method || "");
  }

  function patchAppServerResult(method, result) {
    if (method !== "list-models-for-host") return result;
    try {
      if (Array.isArray(result)) patchModelArray(result, true);
      if (Array.isArray(result?.data)) patchModelArray(result.data, true);
      if (Array.isArray(result?.models)) patchModelArray(result.models, true);
      patchModelContainer(result);
    } catch (error) {
      state.patchFailures.push(String(error?.stack || error));
    }
    return result;
  }

  function patchAppServerClient(client) {
    if (!client || typeof client.sendRequest !== "function") return false;
    if (client.__codexSwitchGateModelRequestPatch) return true;
    const original = client.__codexSwitchGateOriginalSendRequest || client.sendRequest.bind(client);
    client.__codexSwitchGateOriginalSendRequest = original;
    client.sendRequest = async function codexSwitchGateSendRequest(method, params, options) {
      const result = await original(method, params, options);
      if (!modelNames().length) await loadCatalog();
      return patchAppServerResult(appServerMethod(String(method || ""), params), result);
    };
    client.__codexSwitchGateModelRequestPatch = true;
    return true;
  }

  function installAppServerRequestPatch() {
    if (state.appServerRequestPatchInstalled) return;
    void Promise.resolve().then(async () => {
      const module = await loadAppModule("use-host-config-");
      const candidates = Object.values(module).filter((value) => value && typeof value === "object");
      let patched = 0;
      for (const candidate of candidates) {
        if (patchAppServerClient(candidate)) patched += 1;
        if (typeof candidate.sendRequest !== "function" && typeof candidate.get === "function") {
          try { if (patchAppServerClient(candidate.get())) patched += 1; } catch {}
        }
      }
      if (patched > 0) state.appServerRequestPatchInstalled = true;
    }).catch((error) => {
      state.patchFailures.push(String(error?.message || error));
    });
  }

  function refreshPass() {
    if (!modelNames().length) return false;
    let changed = false;
    try {
      patchStatsig();
      if (patchVisibleModelLabels()) changed = true;
      installAppServerRequestPatch();
    } catch (error) {
      state.patchFailures.push(String(error?.stack || error));
    }
    return changed;
  }

  function scheduleRefresh(durationMs = 2500) {
    state.refreshUntil = Math.max(state.refreshUntil || 0, Date.now() + durationMs);
    if (state.refreshTimer) return;
    const tick = () => {
      state.refreshTimer = 0;
      refreshPass();
      if (Date.now() < state.refreshUntil) state.refreshTimer = window.setTimeout(tick, 120);
    };
    tick();
  }

  function install() {
    state.installed = true;
    state.installedAt = new Date().toISOString();
    installAppServerMessagePatch();
    installAppServerRequestPatch();
    void loadCatalog().then(() => scheduleRefresh(4000));
    const observer = state.observer || new MutationObserver((mutations) => {
      if (!modelNames().length) return;
      if (mutations.some((mutation) => Array.from(mutation.addedNodes || []).some((node) => node.nodeType === 1))) scheduleRefresh(1200);
    });
    if (!state.observer) {
      state.observer = observer;
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  install();
})();
`
}

async function evaluate(webSocketUrl, expression, awaitPromise = false) {
  const session = new CdpSession(webSocketUrl)
  await session.open()
  try {
    await session.command("Runtime.enable")
    const result = await session.command("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    })
    return result?.result?.result
  } finally {
    session.close()
  }
}

async function addScriptAndEvaluate(webSocketUrl, script) {
  const session = new CdpSession(webSocketUrl)
  await session.open()
  try {
    await session.command("Runtime.enable")
    await session.command("Page.addScriptToEvaluateOnNewDocument", { source: script })
    await session.command("Runtime.evaluate", {
      expression: script,
      awaitPromise: false,
      returnByValue: true,
      userGesture: true,
    })
  } finally {
    session.close()
  }
}

function normalizeCatalog(catalog) {
  const seen = new Set()
  const models = []
  const labels = {}
  if (catalog?.labels && typeof catalog.labels === "object") {
    for (const [key, value] of Object.entries(catalog.labels)) {
      const id = String(key || "").trim()
      const label = typeof value === "string" ? value.trim() : ""
      if (id && label) labels[id] = label
    }
  }
  for (const entry of Array.isArray(catalog?.models) ? catalog.models : []) {
    const normalized =
      typeof entry === "string"
        ? { id: entry.trim(), label: "" }
        : entry && typeof entry === "object"
          ? {
              id: String(entry.model || entry.id || entry.slug || "").trim(),
              label: String(entry.label || "").trim(),
            }
          : null
    if (!normalized?.id || seen.has(normalized.id)) continue
    seen.add(normalized.id)
    models.push({
      id: normalized.id,
    })
    if (normalized.label) labels[normalized.id] = normalized.label
  }
  const fallbackModel = typeof catalog?.model === "string" ? catalog.model.trim() : ""
  const defaultModel = typeof catalog?.default_model === "string" ? catalog.default_model.trim() : ""
  const firstModel = defaultModel || fallbackModel || models[0]?.id || ""
  return {
    status: models.length ? "ok" : catalog?.status || "empty",
    message: typeof catalog?.message === "string" ? catalog.message : "",
    model: fallbackModel || firstModel,
    default_model: firstModel,
    model_provider: typeof catalog?.model_provider === "string" ? catalog.model_provider : "codex_switchgate",
    provider_name: "codex_switchgate",
    models,
    labels,
    loaded_at: typeof catalog?.loaded_at === "string" ? catalog.loaded_at : new Date().toISOString(),
  }
}

async function modelCatalog(relayBaseUrl) {
  try {
    const baseUrl = relayBaseUrl.replace(/\/+$/, "")
    const payload = await queryJson(`${baseUrl}/v1/models`)
    let labels = {}
    try {
      const labelPayload = await queryJson(`${baseUrl}/api/codex-desktop/model-labels`)
      if (Array.isArray(labelPayload?.models)) {
        labels = Object.fromEntries(
          labelPayload.models
            .map((item) => [String(item?.id || "").trim(), String(item?.label || "").trim()])
            .filter(([id, label]) => id && label),
        )
      }
    } catch {}
    const models = Array.isArray(payload?.data)
      ? payload.data
          .map((item) => ({
            id: typeof item?.id === "string" ? item.id.trim() : "",
            label: typeof labels[item?.id] === "string" ? labels[item.id] : "",
          }))
          .filter((item) => item.id)
      : []
    return normalizeCatalog({
      status: models.length ? "ok" : "empty",
      model: models[0]?.id || "",
      default_model: models[0]?.id || "",
      model_provider: "codex_switchgate",
      provider_name: "codex_switchgate",
      models,
      labels,
    })
  } catch (error) {
    return normalizeCatalog({
      status: "failed",
      message: error.message || String(error),
      model: "",
      default_model: "",
      model_provider: "codex_switchgate",
      provider_name: "codex_switchgate",
      models: [],
    })
  }
}

function modelListFromCatalog(catalog) {
  const normalized = normalizeCatalog(catalog)
  return {
    ok: normalized.models.length > 0,
    count: normalized.models.length,
    models: normalized.models.slice(0, 30).map((model) => model.id),
    error: normalized.status === "failed" ? normalized.message : "",
  }
}

async function status(options) {
  const installPath = await latestCodexInstallPath()
  const exe = codexExeFromInstall(installPath)
  const catalog = await modelCatalog(options.relayBaseUrl)
  const models = modelListFromCatalog(catalog)
  let targets = []
  let target = null
  let cdpReachable = false
  let injected = false
  let injectionInfo = null
  let cdpError = ""
  try {
    targets = await listTargets(options.debugPort)
    cdpReachable = true
    target = pickCodexTarget(targets)
    if (target?.webSocketDebuggerUrl) {
      const probe = `(() => {
        const state = window.__codexSwitchGateModelWhitelist;
        return state
          ? {
              installed: !!state.installed,
              installedAt: state.installedAt || "",
              modelCount: Array.isArray(state.catalog?.models) ? state.catalog.models.length : 0,
              failures: (state.patchFailures || []).slice(-5),
            }
          : { installed: false, installedAt: "", modelCount: 0, failures: [] };
      })()`
      const result = await evaluate(target.webSocketDebuggerUrl, probe, false)
      injectionInfo = result?.value || null
      injected = Boolean(injectionInfo?.installed)
    }
  } catch (error) {
    cdpError = error.message || String(error)
  }
  const runningWithoutCdp = await codexMainProcessAlreadyRunning()
  const desktopProcessCount = await desktopCodexProcessCount()

  return {
    debugPort: options.debugPort,
    relayBaseUrl: options.relayBaseUrl,
    codexRunningWithoutCdp: runningWithoutCdp,
    desktopProcessCount,
    cdpReachable,
    cdpError,
    targetFound: Boolean(target),
    targetTitle: target?.title || "",
    targetUrl: target?.url || "",
    injected,
    injectionInfo,
    targetCount: targets.length,
    codexInstallPath: installPath,
    codexExePath: exe,
    codexExeExists: exe ? await exists(exe) : false,
    modelSourceOk: models.ok,
    modelSourceError: models.error,
    modelCount: models.count,
    modelPreview: models.models,
    healthy: cdpReachable && Boolean(target) && injected && models.ok,
  }
}

async function inject(options) {
  const targets = await listTargets(options.debugPort)
  const target = pickCodexTarget(targets)
  if (!target?.webSocketDebuggerUrl) throw new Error("没有找到可注入的 Codex 页面。请用带模型白名单的启动按钮重新打开 Codex。")
  const catalog = await modelCatalog(options.relayBaseUrl)
  if (!catalog.models.length) throw new Error(catalog.message || "模型目录为空，无法注入 Codex 模型白名单")
  await addScriptAndEvaluate(target.webSocketDebuggerUrl, injectionScript(catalog))
  await sleep(300)
  return {
    status: await status(options),
    message: "已向当前 Codex 桌面端注入模型白名单补丁",
  }
}

async function startAndInject(options, message) {
  const installPath = await latestCodexInstallPath()
  const exe = codexExeFromInstall(installPath)
  if (!exe || !(await exists(exe))) throw new Error("没有找到 Codex.exe")
  const args = [
    `--remote-debugging-port=${options.debugPort}`,
    `--remote-allow-origins=http://127.0.0.1:${options.debugPort}`,
  ]
  let launchedProcessId = 0
  if (process.platform === "win32") {
    const appUserModelId = packagedAppUserModelId(installPath)
    if (!appUserModelId) throw new Error(`无法从安装目录解析 Codex AppUserModelId：${installPath}`)
    launchedProcessId = await activatePackagedApp(appUserModelId, args)
  } else {
    const child = spawn(exe, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    })
    child.unref()
    launchedProcessId = child.pid || 0
  }

  let lastError = null
  for (let index = 0; index < INJECT_RETRY_COUNT; index += 1) {
    try {
      const result = await inject(options)
      return {
        ...result,
        message,
        launchedProcessId,
      }
    } catch (error) {
      lastError = error
      await sleep(INJECT_RETRY_DELAY_MS)
    }
  }
  throw new Error(`Codex 已启动，但注入超时：${lastError?.message || String(lastError)}`)
}

async function launch(options) {
  try {
    return await inject(options)
  } catch {
  }
  if (await codexMainProcessAlreadyRunning()) {
    throw new Error("Codex 桌面端已经在运行，但没有开放模型白名单需要的 CDP 端口。请点击“关闭并重启注入”。")
  }
  return startAndInject(options, "已启动带模型白名单的 Codex，并完成注入")
}

async function restart(options) {
  const closedProcessCount = await requestCodexDesktopClose()
  const exited = await waitForCodexDesktopExit()
  if (!exited) throw new Error("Codex 桌面端未能正常关闭，请手动完全退出 Codex 后再启动带模型白名单")
  const result = await startAndInject(options, "已关闭现有 Codex，并重启完成模型白名单注入")
  return { ...result, closedProcessCount }
}

async function main() {
  const action = process.argv[2]
  const options = {
    debugPort: numberArg("debug-port", DEFAULT_DEBUG_PORT),
    relayBaseUrl: stringArg("relay-base-url", DEFAULT_RELAY_BASE_URL),
  }
  if (action === "status") {
    process.stdout.write(`${JSON.stringify(await status(options))}\n`)
    return
  }
  if (action === "inject") {
    process.stdout.write(`${JSON.stringify(await inject(options))}\n`)
    return
  }
  if (action === "launch") {
    process.stdout.write(`${JSON.stringify(await launch(options))}\n`)
    return
  }
  if (action === "restart") {
    process.stdout.write(`${JSON.stringify(await restart(options))}\n`)
    return
  }
  throw new Error(`未知 Codex 模型白名单动作：${action || ""}`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
