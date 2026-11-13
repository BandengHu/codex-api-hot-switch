#!/usr/bin/env node
"use strict"

const http = require("node:http")
const { DATA_DIR, remoteBase } = require("./config.cjs")
const {
  currentSession,
  handleApi,
  handleUnauthorized,
  redirect,
  sendFile,
} = require("./handlers.cjs")
const { proxy } = require("./proxy.cjs")

const HOST = process.env.SWITCHGATE_SHELL_HOST || process.env.HOSTNAME || "127.0.0.1"
const PORT = Number(process.env.PORT || 8787)

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`)
  const pathname = url.pathname

  if (pathname === "/__shell/styles.css") {
    sendFile(response, "styles.css", "text/css; charset=utf-8")
    return
  }
  if (pathname === "/__shell/app.js") {
    sendFile(response, "app.js", "application/javascript; charset=utf-8")
    return
  }
  if (pathname === "/__shell/api" || pathname.startsWith("/__shell/api/")) {
    if (await handleApi(request, response, pathname)) return
  }

  if (pathname === "/" || pathname === "/index.html") {
    sendFile(response, "index.html", "text/html; charset=utf-8")
    return
  }

  if (pathname === "/console" || pathname === "/console/") {
    if (!currentSession(request)) {
      redirect(response, "/")
      return
    }
    proxy(request, response, "/")
    return
  }
  if (pathname.startsWith("/console/")) {
    if (!currentSession(request)) {
      redirect(response, "/")
      return
    }
    proxy(request, response, pathname.slice("/console".length))
    return
  }
  // API 调用只依赖服务器 Key；网页登录只保护控制台和设置。
  if (
    !currentSession(request) &&
    pathname.startsWith("/api/") &&
    !pathname.startsWith("/api/web-search") &&
    !pathname.startsWith("/api/dsh-search")
  ) {
    handleUnauthorized(request, response, pathname)
    return
  }
  proxy(request, response, pathname)
})

// SSE 与长响应不能被 Node 默认超时截断。
server.requestTimeout = 0
server.headersTimeout = 0
server.keepAliveTimeout = 65_000

server.listen(PORT, HOST, () => {
  console.log(`[shell] listening on http://${HOST}:${PORT}`)
  console.log(`[shell] remote ${remoteBase()}`)
  console.log(`[shell] data ${DATA_DIR}`)
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
