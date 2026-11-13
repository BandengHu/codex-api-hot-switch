#!/usr/bin/env node
"use strict"

/**
 * 本地壳：只把 127.0.0.1:8787 的请求转发到远端 SwitchGate。
 *
 * 本地不读取、不缓存任何供应商配置或密钥；控制台、模型列表、
 * /v1 请求和 SSE 流全部以流式方式透传。
 */

const http = require("node:http")
const https = require("node:https")

const LOCAL_HOST = process.env.HOSTNAME || "127.0.0.1"
const LOCAL_PORT = Number(process.env.PORT || 8787)
const REMOTE_BASE = process.env.SWITCHGATE_REMOTE_BASE || "http://127.0.0.1:54140"

const remote = new URL(REMOTE_BASE)
const remoteTransport = remote.protocol === "https:" ? https : http
const remotePort = Number(remote.port || (remote.protocol === "https:" ? 443 : 80))

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
  const result = {}
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    result[name] = value
  }
  return result
}

function proxyRequest(req, res) {
  const target = new URL(req.url || "/", remote)
  const headers = filterHeaders(req.headers)
  headers.host = remote.host
  headers["x-forwarded-host"] = req.headers.host || `${LOCAL_HOST}:${LOCAL_PORT}`
  headers["x-forwarded-proto"] = "http"

  const upstream = remoteTransport.request(
    {
      protocol: remote.protocol,
      hostname: remote.hostname,
      port: remotePort,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, filterHeaders(upstreamRes.headers))
      upstreamRes.pipe(res)
    },
  )

  upstream.on("error", (error) => {
    console.error(`[remote-shell] ${req.method} ${req.url} -> ${error.message}`)
    if (res.headersSent) {
      res.destroy(error)
      return
    }
    res.writeHead(502, { "content-type": "application/json; charset=utf-8" })
    res.end(JSON.stringify({ error: { message: `远端中转不可达：${error.message}` } }))
  })

  req.pipe(upstream)
}

const server = http.createServer((req, res) => {
  if (req.url === "/__shell/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" })
    res.end(JSON.stringify({ ok: true, remote: REMOTE_BASE }))
    return
  }
  proxyRequest(req, res)
})

// SSE 和长响应不能被 Node 默认超时截断。
server.requestTimeout = 0
server.headersTimeout = 0
server.keepAliveTimeout = 65_000

server.listen(LOCAL_PORT, LOCAL_HOST, () => {
  console.log(`[remote-shell] listening on http://${LOCAL_HOST}:${LOCAL_PORT} -> ${REMOTE_BASE}`)
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)))
}

