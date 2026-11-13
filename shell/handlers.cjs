"use strict"

const path = require("node:path")
const { readFileSync } = require("node:fs")
const {
  clearServerKey,
  remoteBase,
  readServerKey,
  saveRemoteBase,
  saveServerKey,
} = require("./config.cjs")
const { PASSWORD_MIN_LENGTH } = require("./auth.cjs")
const {
  configurePassword,
  sessionSecret,
  setupRequired,
  verifyLogin,
} = require("./store.cjs")
const {
  clearSessionCookie,
  cookieValue,
  decodeSession,
  encodeSession,
  newExpiry,
  sessionCookie,
} = require("./session.cjs")
const { requestRemote, verifyServerKey } = require("./upstream.cjs")

const PUBLIC_DIR = path.join(__dirname, "public")

function readBody(request, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error("请求体过大"))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    request.on("error", reject)
  })
}

async function readJson(request) {
  const text = await readBody(request)
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error("请求体不是合法 JSON")
  }
}

function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    ...headers,
  })
  response.end(body)
}

function sendFile(response, fileName, contentType) {
  const body = readFileSync(path.join(PUBLIC_DIR, fileName))
  response.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-length": body.length,
  })
  response.end(body)
}

function redirect(response, location, headers = {}) {
  response.writeHead(303, { location, ...headers })
  response.end()
}

function isSecure(request) {
  return request.socket.encrypted === true || request.headers["x-forwarded-proto"] === "https"
}

function currentSession(request) {
  try {
    const secret = sessionSecret()
    return decodeSession(cookieValue(request.headers.cookie), secret)
  } catch {
    return null
  }
}

function requireSession(request, response) {
  const session = currentSession(request)
  if (!session) {
    sendJson(response, 401, { error: { message: "请先登录本地壳" } })
    return null
  }
  return session
}

function statusPayload(request) {
  const session = currentSession(request)
  return {
    setupRequired: setupRequired(),
    authenticated: Boolean(session),
    expiresAt: session?.expiresAt ?? 0,
    serverKeyConfigured: Boolean(readServerKey()),
    remoteBase: remoteBase(),
    sessionTtlSeconds: 24 * 60 * 60,
  }
}

async function handleLogin(request, response) {
  const body = await readJson(request)
  const password = typeof body.password === "string" ? body.password : ""
  if (!verifyLogin(password)) {
    sendJson(response, 401, { error: { message: "登录密码无效" } })
    return
  }
  const session = { expiresAt: newExpiry() }
  const token = encodeSession(session, sessionSecret())
  sendJson(response, 200, { ok: true, expiresAt: session.expiresAt }, {
    "set-cookie": sessionCookie(token, isSecure(request)),
  })
}

async function handleSetup(request, response) {
  if (!setupRequired()) {
    sendJson(response, 409, { error: { message: "本地壳已经完成初始化" } })
    return
  }
  const body = await readJson(request)
  const password = typeof body.password === "string" ? body.password : ""
  if (password.length < PASSWORD_MIN_LENGTH) {
    sendJson(response, 400, { error: { message: `登录密码至少 ${PASSWORD_MIN_LENGTH} 位` } })
    return
  }
  configurePassword(password)
  const session = { expiresAt: newExpiry() }
  const token = encodeSession(session, sessionSecret())
  sendJson(response, 200, { ok: true, expiresAt: session.expiresAt }, {
    "set-cookie": sessionCookie(token, isSecure(request)),
  })
}

async function handleServerKey(request, response) {
  if (!requireSession(request, response)) return
  const body = await readJson(request)
  const serverKey = typeof body.serverKey === "string" ? body.serverKey.trim() : ""
  if (!serverKey) {
    sendJson(response, 400, { error: { message: "服务器 API Key 不能为空" } })
    return
  }
  const result = await verifyServerKey(serverKey)
  if (!result.ok) {
    sendJson(response, 401, {
      error: {
        message: result.configured
          ? "服务器 API Key 无效"
          : "服务器尚未初始化访问密钥，请先在服务器端生成",
      },
    })
    return
  }
  saveServerKey(serverKey)
  sendJson(response, 200, { ok: true, serverKeyConfigured: true })
}

async function handleServerKeyDelete(request, response) {
  if (!requireSession(request, response)) return
  clearServerKey()
  sendJson(response, 200, { ok: true, serverKeyConfigured: false })
}

async function handleRemoteBase(request, response) {
  if (!requireSession(request, response)) return
  const body = await readJson(request)
  saveRemoteBase(body.remoteBase)
  sendJson(response, 200, { ok: true, remoteBase: remoteBase() })
}

async function handleRotateServerKey(request, response) {
  if (!requireSession(request, response)) return
  const responseFromRemote = await requestRemote("/api/auth/rotate", {
    method: "POST",
    body: {},
  })
  const text = responseFromRemote.body.toString("utf8")
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {}
  if (responseFromRemote.status !== 200 || typeof payload?.apiKey !== "string") {
    sendJson(response, responseFromRemote.status === 401 ? 401 : 502, {
      error: { message: payload?.error?.message || `服务器更换 Key 失败（HTTP ${responseFromRemote.status}）` },
    })
    return
  }
  saveServerKey(payload.apiKey)
  sendJson(response, 200, { ok: true, apiKey: payload.apiKey, serverKeyConfigured: true })
}

function handleLogout(request, response) {
  sendJson(response, 200, { ok: true }, { "set-cookie": clearSessionCookie() })
}

function handleUnauthorized(request, response, pathname) {
  if (pathname.startsWith("/api/")) {
    sendJson(response, 401, {
      error: { message: "请先登录本地壳控制台", type: "authentication_error" },
    })
    return
  }
  redirect(response, "/")
}

async function handleApi(request, response, pathname) {
  try {
    if (pathname === "/__shell/api/status" && request.method === "GET") {
      sendJson(response, 200, statusPayload(request))
      return true
    }
    if (pathname === "/__shell/api/setup" && request.method === "POST") {
      await handleSetup(request, response)
      return true
    }
    if (pathname === "/__shell/api/login" && request.method === "POST") {
      await handleLogin(request, response)
      return true
    }
    if (pathname === "/__shell/api/logout" && request.method === "POST") {
      handleLogout(request, response)
      return true
    }
    if (pathname === "/__shell/api/server-key" && request.method === "POST") {
      await handleServerKey(request, response)
      return true
    }
    if (pathname === "/__shell/api/server-key" && request.method === "DELETE") {
      await handleServerKeyDelete(request, response)
      return true
    }
    if (pathname === "/__shell/api/remote-base" && request.method === "POST") {
      await handleRemoteBase(request, response)
      return true
    }
    if (pathname === "/__shell/api/server-key/rotate" && request.method === "POST") {
      await handleRotateServerKey(request, response)
      return true
    }
    if (pathname === "/__shell/health") {
      sendJson(response, 200, { ok: true, remote: remoteBase() })
      return true
    }
    return false
  } catch (error) {
    sendJson(response, 400, {
      error: { message: error instanceof Error ? error.message : String(error) },
    })
    return true
  }
}

module.exports = {
  currentSession,
  handleApi,
  handleUnauthorized,
  redirect,
  sendFile,
}
