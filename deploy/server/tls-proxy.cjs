"use strict"

const fs = require("node:fs")
const http = require("node:http")
const https = require("node:https")
const net = require("node:net")

const listenHost = process.env.SWITCHGATE_TLS_HOST || "0.0.0.0"
const listenPort = Number(process.env.SWITCHGATE_TLS_PORT || 443)
const upstreamHost = process.env.SWITCHGATE_UPSTREAM_HOST || "127.0.0.1"
const upstreamPort = Number(process.env.SWITCHGATE_UPSTREAM_PORT || 54141)

// 知识库服务挂在同一域名下的 /kb 前缀，独立端口、独立进程，
// 与中转应用互不影响；前缀置空即关闭该路由。
const kbPrefix = process.env.SWITCHGATE_KB_PREFIX ?? "/kb"
const kbHost = process.env.SWITCHGATE_KB_HOST || "127.0.0.1"
const kbPort = Number(process.env.SWITCHGATE_KB_PORT || 54142)
const certPath =
  process.env.SWITCHGATE_TLS_CERT ||
  "/etc/letsencrypt/live/huhuanjie.site/fullchain.pem"
const keyPath =
  process.env.SWITCHGATE_TLS_KEY ||
  "/etc/letsencrypt/live/huhuanjie.site/privkey.pem"

function readCertificate() {
  return {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  }
}

function clientAddress(req) {
  const socketAddress = req.socket.remoteAddress || ""
  const forwarded = req.headers["x-forwarded-for"]
  return forwarded ? `${forwarded}, ${socketAddress}` : socketAddress
}

// 跨域头必须挂在代理层，且成功与失败分支都要带：上游 4xx/5xx 若没有这些头，
// 浏览器只会抛 "Failed to fetch"，前端看不到真实错误原因。
const corsAllowOrigin = process.env.SWITCHGATE_CORS_ORIGIN || "*"
const corsFallbackAllowHeaders = "Authorization, Content-Type"

function applyCorsHeaders(headers, req) {
  headers["access-control-allow-origin"] = corsAllowOrigin
  headers["access-control-allow-methods"] = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"
  // Authorization 属于 CORS 规范里的 non-wildcard request-header，
  // 只写 `*` 覆盖不到它，因此优先回显预检请求自己列出的头。
  headers["access-control-allow-headers"] =
    req.headers["access-control-request-headers"] || corsFallbackAllowHeaders
}

function isPreflight(req) {
  return (
    req.method === "OPTIONS" &&
    Boolean(req.headers.origin) &&
    Boolean(req.headers["access-control-request-method"])
  )
}

// /kb 及其子路径命中知识库服务；其余请求照旧走中转应用。
function resolveUpstream(pathname) {
  if (!kbPrefix) return { host: upstreamHost, port: upstreamPort, path: pathname }
  const isKb =
    pathname === kbPrefix ||
    pathname.startsWith(`${kbPrefix}/`) ||
    pathname.startsWith(`${kbPrefix}?`)
  if (!isKb) return { host: upstreamHost, port: upstreamPort, path: pathname }

  // 去掉前缀再转发：浏览器访问 /kb/v1/search → 服务收到 /v1/search
  const stripped = pathname.slice(kbPrefix.length) || "/"
  return {
    host: kbHost,
    port: kbPort,
    path: stripped.startsWith("/") ? stripped : `/${stripped}`,
  }
}

function proxyRequest(req, res) {
  if (isPreflight(req)) {
    const headers = { "content-length": "0" }
    applyCorsHeaders(headers, req)
    headers["access-control-max-age"] = "86400"
    res.writeHead(204, headers)
    res.end()
    return
  }

  const rawUrl = req.url || "/"
  const queryIndex = rawUrl.indexOf("?")
  const pathname = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex)
  const search = queryIndex === -1 ? "" : rawUrl.slice(queryIndex)
  const target = resolveUpstream(pathname)
  const headers = {
    ...req.headers,
    host: req.headers.host || "",
    "x-forwarded-proto": "https",
    "x-forwarded-host": req.headers.host || "",
    "x-forwarded-for": clientAddress(req),
  }
  if (target.host === kbHost && kbPrefix) {
    headers["x-forwarded-prefix"] = kbPrefix
  }
  if (headers.host.endsWith(`:${listenPort}`)) {
    headers.host = headers.host.slice(0, -String(listenPort).length - 1)
  }

  const upstream = http.request(
    {
      host: target.host,
      port: target.port,
      method: req.method,
      path: target.path + search,
      headers,
      timeout: 0,
    },
    (upstreamRes) => {
      const responseHeaders = { ...upstreamRes.headers }
      applyCorsHeaders(responseHeaders, req)
      const contentType = String(responseHeaders["content-type"] || "")
      if (contentType.includes("text/event-stream")) {
        responseHeaders["x-accel-buffering"] = "no"
        responseHeaders["cache-control"] ||= "no-cache, no-transform"
      }
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders)
      upstreamRes.pipe(res)
      upstreamRes.on("error", () => res.destroy())
    },
  )

  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")))
  upstream.on("error", (error) => {
    console.error(`[tls-proxy] upstream error: ${error.message}`)
    if (!res.headersSent) {
      const headers = { "content-type": "application/json; charset=utf-8" }
      applyCorsHeaders(headers, req)
      res.writeHead(502, headers)
    }
    res.end(JSON.stringify({ error: "upstream unavailable" }))
  })

  req.on("aborted", () => upstream.destroy())
  req.pipe(upstream)
}

const server = https.createServer(
  {
    ...readCertificate(),
    minVersion: "TLSv1.2",
    honorCipherOrder: true,
  },
  (req, res) => {
    proxyRequest(req, res)
  },
)

server.on("clientError", (_error, socket) => {
  if (socket.writable && !socket.destroyed) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
  }
})

server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(upstreamPort, upstreamHost, () => {
    const headers = {
      ...req.headers,
      "x-forwarded-proto": "https",
      "x-forwarded-host": req.headers.host || "",
    }
    let requestText = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        for (const item of value) requestText += `${name}: ${item}\r\n`
      } else if (value !== undefined) {
        requestText += `${name}: ${value}\r\n`
      }
    }
    upstream.write(`${requestText}\r\n`)
    if (head?.length) upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  })
  upstream.on("error", () => socket.destroy())
  socket.on("error", () => upstream.destroy())
})

server.listen(listenPort, listenHost, () => {
  console.log(
    `[tls-proxy] https://${listenHost}:${listenPort} -> http://${upstreamHost}:${upstreamPort}`,
  )
})

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000).unref()
  })
}
