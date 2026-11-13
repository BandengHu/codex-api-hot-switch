"use strict"

const http = require("node:http")
const https = require("node:https")
const { remoteBase, readServerKey } = require("./config.cjs")
const { filterHeaders } = require("./upstream.cjs")

function stripShellCookie(cookieHeader) {
  return String(cookieHeader || "")
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item && !item.startsWith("switchgate_shell_session="))
    .join("; ")
}

function proxy(request, response, pathname) {
  const base = remoteBase()
  const target = new URL(`${pathname}${new URL(request.url, "http://localhost").search}`, `${base}/`)
  const headers = filterHeaders(request.headers)
  headers["accept-encoding"] = "identity"
  headers.host = target.host
  headers["x-forwarded-host"] = request.headers.host || ""
  headers["x-forwarded-proto"] = request.socket.encrypted ? "https" : "http"
  const serverKey = readServerKey()
  if (serverKey) {
    headers.authorization = `Bearer ${serverKey}`
    delete headers.cookie
  } else {
    const cookie = stripShellCookie(request.headers.cookie)
    if (cookie) headers.cookie = cookie
    else delete headers.cookie
  }

  const transport = target.protocol === "https:" ? https : http
  const upstream = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers,
    },
    (upstreamResponse) => {
      const outgoing = filterHeaders(upstreamResponse.headers)
      // 服务器的登录 Cookie 由壳自己管理，不能覆盖本地壳会话。
      const cookies = upstreamResponse.headers["set-cookie"]
      const kept = (Array.isArray(cookies) ? cookies : cookies ? [cookies] : []).filter(
        (item) => !String(item).startsWith("switchgate_session="),
      )
      if (kept.length) outgoing["set-cookie"] = kept
      else delete outgoing["set-cookie"]
      response.writeHead(upstreamResponse.statusCode || 502, outgoing)
      upstreamResponse.pipe(response)
    },
  )

  upstream.on("error", (error) => {
    console.error(`[shell] ${request.method} ${request.url} -> ${error.message}`)
    if (response.headersSent) {
      response.destroy(error)
      return
    }
    response.writeHead(502, { "content-type": "application/json; charset=utf-8" })
    response.end(JSON.stringify({ error: { message: `远端中转不可达：${error.message}` } }))
  })
  request.pipe(upstream)
}

module.exports = { proxy }
