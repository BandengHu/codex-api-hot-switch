"use strict"

const http = require("node:http")
const https = require("node:https")
const { remoteBase, readServerKey } = require("./config.cjs")

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

function filterHeaders(headers) {
  const output = {}
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    output[name] = value
  }
  return output
}

function upstreamRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http
    const request = transport.request(url, options, (response) => {
      const chunks = []
      response.on("data", (chunk) => chunks.push(chunk))
      response.on("end", () => {
        resolve({
          status: response.statusCode || 502,
          headers: response.headers,
          body: Buffer.concat(chunks),
        })
      })
      response.on("error", reject)
    })
    request.setTimeout(30_000, () => request.destroy(new Error("远端服务器响应超时")))
    request.on("error", reject)
    if (body) request.write(body)
    request.end()
  })
}

async function requestRemote(pathname, options = {}) {
  const base = remoteBase()
  const url = new URL(pathname, `${base}/`)
  const headers = filterHeaders(options.headers || {})
  headers.accept = "application/json"
  const serverKey = readServerKey()
  if (serverKey) headers.authorization = `Bearer ${serverKey}`
  const body =
    options.body === undefined || options.body === null
      ? null
      : Buffer.from(typeof options.body === "string" ? options.body : JSON.stringify(options.body))
  if (body) {
    headers["content-type"] = "application/json"
    headers["content-length"] = String(body.length)
  }
  try {
    return await upstreamRequest(url, { method: options.method || "GET", headers }, body)
  } catch (error) {
    throw new Error(`连接远端 ${base} 失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function remoteJson(pathname, options) {
  const response = await requestRemote(pathname, options)
  const text = response.body.toString("utf8")
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }
  if (response.status >= 200 && response.status < 300) return payload
  const message =
    payload && typeof payload === "object"
      ? payload.error?.message || payload.error || payload.message
      : ""
  throw new Error(String(message || `远端返回 HTTP ${response.status}`))
}

async function verifyServerKey(serverKey) {
  const base = remoteBase()
  const url = new URL("/api/auth/status", `${base}/`)
  let response
  try {
    response = await upstreamRequest(
      url,
      {
        method: "GET",
        headers: { accept: "application/json", authorization: `Bearer ${String(serverKey || "").trim()}` },
      },
      null,
    )
  } catch (error) {
    throw new Error(`连接远端 ${base} 失败：${error instanceof Error ? error.message : String(error)}`)
  }
  let payload = null
  try {
    payload = JSON.parse(response.body.toString("utf8"))
  } catch {}
  if (response.status === 401) return { ok: false, configured: payload?.configured === true }
  if (response.status !== 200) {
    throw new Error(`远端返回 HTTP ${response.status}`)
  }
  return { ok: payload?.authenticated === true, configured: payload?.configured === true }
}

module.exports = {
  filterHeaders,
  remoteJson,
  requestRemote,
  verifyServerKey,
}
