"use strict"

const $ = (id) => document.getElementById(id)
const state = { authenticated: false, setupRequired: false, remoteBase: "", serverKeyConfigured: false, expiresAt: 0 }

function show(element, text, ok = false) {
  element.textContent = text
  element.classList.toggle("ok", ok)
  element.classList.toggle("bad", !ok)
  element.classList.remove("hidden")
}

function hide(element) {
  element.classList.add("hidden")
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) },
    credentials: "same-origin",
  })
  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }
  if (!response.ok) {
    throw new Error(payload?.error?.message || payload?.error || `请求失败（HTTP ${response.status}）`)
  }
  return payload
}

function formatExpiry(timestamp) {
  if (!timestamp) return "—"
  return new Date(timestamp * 1000).toLocaleString("zh-CN", { hour12: false })
}

function render() {
  $("setup-card").classList.toggle("hidden", !state.setupRequired)
  $("login-card").classList.toggle("hidden", state.setupRequired || state.authenticated)
  $("console").classList.toggle("hidden", !state.authenticated)
  $("fact-remote").textContent = state.remoteBase || "—"
  $("fact-key").textContent = state.serverKeyConfigured ? "已配置" : "未配置"
  $("fact-key").className = state.serverKeyConfigured ? "ok" : "bad"
  $("fact-session").textContent = state.authenticated ? `有效至 ${formatExpiry(state.expiresAt)}` : "未登录"
  if (!$("remote-base").value) $("remote-base").value = state.remoteBase || ""
}

async function refreshStatus() {
  const status = await api("/__shell/api/status")
  Object.assign(state, status)
  render()
}

async function postThenRefresh(path, body) {
  await api(path, { method: "POST", body: JSON.stringify(body || {}) })
  await refreshStatus()
}

$("setup-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  const password = $("setup-password").value
  const confirm = $("setup-confirm").value
  hide($("setup-error"))
  if (password !== confirm) {
    show($("setup-error"), "两次输入的密码不一致")
    return
  }
  try {
    await postThenRefresh("/__shell/api/setup", { password })
  } catch (error) {
    show($("setup-error"), error.message)
  }
})

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  hide($("login-error"))
  try {
    await postThenRefresh("/__shell/api/login", { password: $("login-password").value })
    $("login-password").value = ""
  } catch (error) {
    show($("login-error"), error.message)
  }
})

$("key-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  hide($("key-message"))
  try {
    await postThenRefresh("/__shell/api/server-key", { serverKey: $("server-key").value })
    $("server-key").value = ""
    show($("key-message"), "服务器 Key 已验证并保存", true)
  } catch (error) {
    show($("key-message"), error.message)
  }
})

$("remote-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  hide($("remote-message"))
  try {
    await postThenRefresh("/__shell/api/remote-base", { remoteBase: $("remote-base").value })
    show($("remote-message"), "服务器地址已保存", true)
  } catch (error) {
    show($("remote-message"), error.message)
  }
})

$("rotate-key").addEventListener("click", async () => {
  hide($("key-message"))
  if (!confirm("将在服务器生成新的 API Key，旧 Key 会立即失效。继续？")) return
  try {
    await api("/__shell/api/server-key/rotate", { method: "POST", body: "{}" })
    await refreshStatus()
    show($("key-message"), "已在服务器生成新 Key，并保存到本机壳", true)
  } catch (error) {
    show($("key-message"), error.message)
  }
})

$("clear-key").addEventListener("click", async () => {
  hide($("key-message"))
  if (!confirm("清除本机保存的服务器 API Key？清除后中转会无法访问服务器。")) return
  try {
    await api("/__shell/api/server-key", { method: "DELETE" })
    await refreshStatus()
    show($("key-message"), "本机 Key 已清除", true)
  } catch (error) {
    show($("key-message"), error.message)
  }
})

$("logout").addEventListener("click", async () => {
  await api("/__shell/api/logout", { method: "POST", body: "{}" }).catch(() => undefined)
  await refreshStatus()
})

$("open-console").addEventListener("click", () => {
  if (!state.remoteBase) {
    show($("key-message"), "请先填写并保存服务器地址")
    return
  }
  window.location.href = "/console"
})

refreshStatus().catch((error) => show($("login-error"), error.message))
