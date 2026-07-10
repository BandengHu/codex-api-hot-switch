#!/usr/bin/env node

"use strict"

const RELAY_WEB_SEARCH_TOOL_NAME = "web_search"
const EXA_WEB_SEARCH_URL = "https://mcp.exa.ai/mcp"
const PARALLEL_WEB_SEARCH_URL = "https://search.parallel.ai/mcp"

const SERVER_NAME = "switchgate-web-search"
const SERVER_VERSION = "0.1.0"
const DEFAULT_PROTOCOL_VERSION = "2024-11-05"
const MAX_RESPONSE_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 25_000
const NO_RESULTS = "No search results found. Please try a different query."

const TOOL_DEFINITION = {
  name: RELAY_WEB_SEARCH_TOOL_NAME,
  description:
    "Search the public web for up-to-date information. Use this when the answer may depend on recent events, current facts, or information not contained in the conversation.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description: "The search query to look up on the web.",
      },
      provider: {
        type: "string",
        enum: ["auto", "exa", "parallel"],
        description: "Optional search backend override. Defaults to environment-based auto selection.",
      },
      numResults: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: "Maximum number of Exa results to request.",
      },
      type: {
        type: "string",
        enum: ["auto", "fast", "deep"],
        description: "Exa search depth.",
      },
      livecrawl: {
        type: "string",
        enum: ["fallback", "preferred"],
        description: "Exa live crawl preference.",
      },
      contextMaxCharacters: {
        type: "integer",
        minimum: 1,
        maximum: 200000,
        description: "Optional Exa context character budget.",
      },
      sessionId: {
        type: "string",
        description: "Optional Parallel session id.",
      },
      modelName: {
        type: "string",
        description: "Optional Parallel model name hint.",
      },
    },
    required: ["query"],
  },
}

function log(message) {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`)
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function envProvider() {
  const value = (
    process.env.CODEX_WEB_SEARCH_PROVIDER ||
    process.env.SWITCHGATE_WEB_SEARCH_PROVIDER ||
    process.env.OPENCODE_WEBSEARCH_PROVIDER ||
    ""
  )
    .trim()
    .toLowerCase()
  if (value === "exa" || value === "parallel") return value
  return undefined
}

function selectedProvider(override) {
  const normalized = typeof override === "string" ? override.trim().toLowerCase() : ""
  if (normalized === "exa" || normalized === "parallel") return normalized
  const env = envProvider()
  if (env) return env
  if (process.env.PARALLEL_API_KEY?.trim()) return "parallel"
  return "exa"
}

function exaUrl() {
  const apiKey = process.env.EXA_API_KEY?.trim()
  if (!apiKey) return EXA_WEB_SEARCH_URL
  const url = new URL(EXA_WEB_SEARCH_URL)
  url.searchParams.set("exaApiKey", apiKey)
  return url.toString()
}

function requestHeaders(provider) {
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  }
  if (provider === "parallel") {
    headers["user-agent"] = "codex-switchgate/0.1"
    const apiKey = process.env.PARALLEL_API_KEY?.trim()
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
  }
  return headers
}

function mcpRequestBody(provider, input) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params:
      provider === "parallel"
        ? {
            name: "web_search",
            arguments: {
              objective: input.query,
              search_queries: [input.query],
              ...(input.sessionId ? { session_id: input.sessionId } : {}),
              ...(input.modelName ? { model_name: input.modelName.slice(0, 100) } : {}),
            },
          }
        : {
            name: "web_search_exa",
            arguments: {
              query: input.query,
              type: input.type || "auto",
              numResults: input.numResults || 8,
              livecrawl: input.livecrawl || "fallback",
              ...(input.contextMaxCharacters
                ? { contextMaxCharacters: input.contextMaxCharacters }
                : {}),
            },
          },
  }
}

function parsePayload(payload) {
  const trimmed = payload.trim()
  if (!trimmed || !trimmed.startsWith("{")) return undefined
  const parsed = JSON.parse(trimmed)
  if (!isObject(parsed)) return undefined
  const content = parsed.result?.content
  if (!Array.isArray(content)) return undefined
  const item = content.find((entry) => isObject(entry) && typeof entry.text === "string")
  return typeof item?.text === "string" && item.text.trim() ? item.text : undefined
}

function parseWebSearchMcpResponse(body) {
  const trimmed = body.trim()
  if (trimmed) {
    const direct = parsePayload(trimmed)
    if (direct) return direct
  }

  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue
    const data = line.slice("data: ".length)
    if (data.trim() === "[DONE]") continue
    const parsed = parsePayload(data)
    if (parsed) return parsed
  }
  return undefined
}

async function boundedText(response) {
  if (!response.body) return await response.text()
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error(`web_search response exceeded ${MAX_RESPONSE_BYTES} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(out)
}

function timeoutMs() {
  const raw = Number.parseInt(process.env.SWITCHGATE_WEB_SEARCH_TIMEOUT_MS || "", 10)
  if (Number.isFinite(raw) && raw >= 1000 && raw <= 120000) return raw
  return DEFAULT_TIMEOUT_MS
}

function withTimeout(signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs())
  const abort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener("abort", abort, { once: true })
  }
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
    },
  }
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : ""
}

function cleanPositiveInteger(value, fallback, min, max) {
  if (value == null || value === "") return fallback
  const number = typeof value === "number" ? value : Number.parseInt(String(value), 10)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(number)))
}

function normalizeWebSearchInput(argumentsValue) {
  if (!isObject(argumentsValue)) {
    throw new Error("web_search arguments must be an object")
  }
  const query = cleanString(argumentsValue.query)
  if (!query) throw new Error("web_search requires a non-empty query")

  const provider = cleanString(argumentsValue.provider).toLowerCase()
  if (provider && provider !== "auto" && provider !== "exa" && provider !== "parallel") {
    throw new Error("web_search provider must be auto, exa, or parallel")
  }

  const type = cleanString(argumentsValue.type).toLowerCase()
  if (type && !["auto", "fast", "deep"].includes(type)) {
    throw new Error("web_search type must be auto, fast, or deep")
  }

  const livecrawl = cleanString(argumentsValue.livecrawl).toLowerCase()
  if (livecrawl && !["fallback", "preferred"].includes(livecrawl)) {
    throw new Error("web_search livecrawl must be fallback or preferred")
  }

  return {
    query,
    provider: provider || "auto",
    numResults: cleanPositiveInteger(argumentsValue.numResults, 8, 1, 20),
    type: type || "auto",
    livecrawl: livecrawl || "fallback",
    contextMaxCharacters: cleanPositiveInteger(
      argumentsValue.contextMaxCharacters,
      undefined,
      1,
      200000,
    ),
    sessionId: cleanString(argumentsValue.sessionId),
    modelName: cleanString(argumentsValue.modelName),
  }
}

async function executeWebSearch(input, signal) {
  if (typeof fetch !== "function") {
    throw new Error("web_search requires Node.js 18+ with global fetch support")
  }
  const provider = selectedProvider(input.provider)
  const timeout = withTimeout(signal)
  try {
    const response = await fetch(provider === "parallel" ? PARALLEL_WEB_SEARCH_URL : exaUrl(), {
      method: "POST",
      headers: requestHeaders(provider),
      body: JSON.stringify(mcpRequestBody(provider, input)),
      signal: timeout.signal,
    })
    const body = await boundedText(response)
    if (!response.ok) {
      throw new Error(`web_search ${provider} returned HTTP ${response.status}: ${body.slice(0, 500)}`)
    }
    return {
      provider,
      query: input.query,
      text: parseWebSearchMcpResponse(body) || NO_RESULTS,
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`web_search ${provider} timed out`)
    }
    throw error
  } finally {
    timeout.done()
  }
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result }
}

function jsonRpcError(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  }
}

let outputFraming = "line"

function writeMessage(message) {
  const json = JSON.stringify(message)
  if (outputFraming === "header") {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`)
    return
  }
  process.stdout.write(`${json}\n`)
}

async function handleRequest(message) {
  if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    writeMessage(jsonRpcError(isObject(message) ? message.id : null, -32600, "Invalid JSON-RPC request"))
    return
  }

  const hasId = Object.prototype.hasOwnProperty.call(message, "id")
  if (!hasId) {
    return
  }

  try {
    switch (message.method) {
      case "initialize": {
        const requestedVersion = cleanString(message.params?.protocolVersion)
        writeMessage(
          jsonRpcResult(message.id, {
            protocolVersion: requestedVersion || DEFAULT_PROTOCOL_VERSION,
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: SERVER_NAME,
              version: SERVER_VERSION,
            },
          }),
        )
        return
      }
      case "ping":
        writeMessage(jsonRpcResult(message.id, {}))
        return
      case "tools/list":
        writeMessage(jsonRpcResult(message.id, { tools: [TOOL_DEFINITION] }))
        return
      case "tools/call": {
        const name = cleanString(message.params?.name)
        if (name !== RELAY_WEB_SEARCH_TOOL_NAME) {
          writeMessage(
            jsonRpcError(message.id, -32602, `Unknown tool: ${name || "(missing)"}`),
          )
          return
        }
        const input = normalizeWebSearchInput(message.params?.arguments)
        const result = await executeWebSearch(input)
        writeMessage(
          jsonRpcResult(message.id, {
            content: [
              {
                type: "text",
                text: result.text,
              },
            ],
          }),
        )
        return
      }
      case "resources/list":
        writeMessage(jsonRpcResult(message.id, { resources: [] }))
        return
      case "prompts/list":
        writeMessage(jsonRpcResult(message.id, { prompts: [] }))
        return
      default:
        writeMessage(jsonRpcError(message.id, -32601, `Method not found: ${message.method}`))
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error)
    log(messageText)
    if (message.method === "tools/call") {
      writeMessage(
        jsonRpcResult(message.id, {
          isError: true,
          content: [
            {
              type: "text",
              text: messageText,
            },
          ],
        }),
      )
      return
    }
    writeMessage(jsonRpcError(message.id, -32603, messageText))
  }
}

function parseHeaderMessage(buffer) {
  const preview = buffer.slice(0, Math.min(buffer.length, 2048)).toString("utf8")
  if (!/^Content-Length:/i.test(preview)) return undefined
  outputFraming = "header"

  const crlfEnd = buffer.indexOf(Buffer.from("\r\n\r\n"))
  const lfEnd = buffer.indexOf(Buffer.from("\n\n"))
  let headerEnd = -1
  let separatorLength = 0
  if (crlfEnd >= 0 && (lfEnd < 0 || crlfEnd < lfEnd)) {
    headerEnd = crlfEnd
    separatorLength = 4
  } else if (lfEnd >= 0) {
    headerEnd = lfEnd
    separatorLength = 2
  }
  if (headerEnd < 0) return null

  const header = buffer.slice(0, headerEnd).toString("ascii")
  const match = header.match(/(?:^|\r?\n)Content-Length:\s*(\d+)/i)
  if (!match) throw new Error("Missing Content-Length header")
  const length = Number.parseInt(match[1], 10)
  if (!Number.isFinite(length) || length < 0) throw new Error("Invalid Content-Length header")

  const bodyStart = headerEnd + separatorLength
  const bodyEnd = bodyStart + length
  if (buffer.length < bodyEnd) return null
  return {
    body: buffer.slice(bodyStart, bodyEnd).toString("utf8"),
    rest: buffer.slice(bodyEnd),
  }
}

function parseLineMessage(buffer) {
  const newline = buffer.indexOf(0x0a)
  if (newline < 0) return null
  const line = buffer.slice(0, newline).toString("utf8").trim()
  return {
    body: line,
    rest: buffer.slice(newline + 1),
  }
}

let inputBuffer = Buffer.alloc(0)
let stdinEnded = false
let pendingRequests = 0
let requestQueue = Promise.resolve()

function maybeExit() {
  if (stdinEnded && pendingRequests === 0) process.exit(0)
}

function enqueueRequest(message) {
  pendingRequests += 1
  requestQueue = requestQueue
    .then(() => handleRequest(message))
    .catch((error) => {
      log(error instanceof Error ? error.stack || error.message : String(error))
    })
    .finally(() => {
      pendingRequests -= 1
      maybeExit()
    })
}

function drainInput() {
  while (inputBuffer.length > 0) {
    while (inputBuffer.length > 0 && (inputBuffer[0] === 0x0a || inputBuffer[0] === 0x0d)) {
      inputBuffer = inputBuffer.slice(1)
    }
    if (inputBuffer.length === 0) return

    let parsed
    try {
      parsed = parseHeaderMessage(inputBuffer)
      if (parsed === undefined) parsed = parseLineMessage(inputBuffer)
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      writeMessage(jsonRpcError(null, -32700, messageText))
      inputBuffer = Buffer.alloc(0)
      return
    }

    if (!parsed) return
    inputBuffer = parsed.rest
    if (!parsed.body) continue

    try {
      enqueueRequest(JSON.parse(parsed.body))
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      writeMessage(jsonRpcError(null, -32700, messageText))
    }
  }
}

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk])
  drainInput()
})

process.stdin.on("end", () => {
  stdinEnded = true
  maybeExit()
})

process.on("uncaughtException", (error) => {
  log(error instanceof Error ? error.stack || error.message : String(error))
})

process.on("unhandledRejection", (reason) => {
  log(reason instanceof Error ? reason.stack || reason.message : String(reason))
})
