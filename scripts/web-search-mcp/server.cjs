"use strict"

const { cleanString, isObject } = require("./shared.cjs")
const { TOOL_DEFINITIONS, executeTool } = require("./tools.cjs")

const SERVER_NAME = "switchgate-web-search"
const SERVER_VERSION = "0.2.0"
const DEFAULT_PROTOCOL_VERSION = "2024-11-05"

function log(message) {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`)
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

async function handleRequest(message) {
  if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return jsonRpcError(isObject(message) ? message.id : null, -32600, "Invalid JSON-RPC request")
  }
  if (!Object.prototype.hasOwnProperty.call(message, "id")) return undefined

  try {
    switch (message.method) {
      case "initialize": {
        const requestedVersion = cleanString(message.params?.protocolVersion)
        return jsonRpcResult(message.id, {
          protocolVersion: requestedVersion || DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        })
      }
      case "ping":
        return jsonRpcResult(message.id, {})
      case "tools/list":
        return jsonRpcResult(message.id, { tools: TOOL_DEFINITIONS })
      case "tools/call": {
        const name = cleanString(message.params?.name)
        const result = await executeTool(name, message.params?.arguments)
        return jsonRpcResult(message.id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        })
      }
      case "resources/list":
        return jsonRpcResult(message.id, { resources: [] })
      case "resources/templates/list":
        return jsonRpcResult(message.id, { resourceTemplates: [] })
      case "prompts/list":
        return jsonRpcResult(message.id, { prompts: [] })
      default:
        return jsonRpcError(message.id, -32601, `Method not found: ${message.method}`)
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error)
    log(messageText)
    if (message.method === "tools/call") {
      return jsonRpcResult(message.id, {
        isError: true,
        content: [{ type: "text", text: messageText }],
      })
    }
    return jsonRpcError(message.id, -32603, messageText)
  }
}

function createMessageParser(writeMessage) {
  let outputFraming = "line"
  let inputBuffer = Buffer.alloc(0)
  let stdinEnded = false
  let pendingRequests = 0
  let requestQueue = Promise.resolve()

  function write(message) {
    const json = JSON.stringify(message)
    if (outputFraming === "header") {
      writeMessage(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`)
      return
    }
    writeMessage(`${json}\n`)
  }

  function maybeExit() {
    return stdinEnded && pendingRequests === 0
  }

  function enqueueRequest(message) {
    pendingRequests += 1
    requestQueue = requestQueue
      .then(async () => {
        const response = await handleRequest(message)
        if (response) write(response)
      })
      .catch((error) => {
        log(error instanceof Error ? error.stack || error.message : String(error))
      })
      .finally(() => {
        pendingRequests -= 1
      })
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
    return { body: buffer.slice(bodyStart, bodyEnd).toString("utf8"), rest: buffer.slice(bodyEnd) }
  }

  function parseLineMessage(buffer) {
    const newline = buffer.indexOf(0x0a)
    if (newline < 0) return null
    return {
      body: buffer.slice(0, newline).toString("utf8").trim(),
      rest: buffer.slice(newline + 1),
    }
  }

  function drainInput() {
    while (inputBuffer.length > 0) {
      while (inputBuffer.length > 0 && (inputBuffer[0] === 0x0a || inputBuffer[0] === 0x0d)) {
        inputBuffer = inputBuffer.slice(1)
      }
      if (!inputBuffer.length) return
      let parsed
      try {
        parsed = parseHeaderMessage(inputBuffer)
        if (parsed === undefined) parsed = parseLineMessage(inputBuffer)
      } catch (error) {
        write(jsonRpcError(null, -32700, error instanceof Error ? error.message : String(error)))
        inputBuffer = Buffer.alloc(0)
        return
      }
      if (!parsed) return
      inputBuffer = parsed.rest
      if (!parsed.body) continue
      try {
        enqueueRequest(JSON.parse(parsed.body))
      } catch (error) {
        write(jsonRpcError(null, -32700, error instanceof Error ? error.message : String(error)))
      }
    }
  }

  return {
    push(chunk) {
      inputBuffer = Buffer.concat([inputBuffer, chunk])
      drainInput()
    },
    end() {
      stdinEnded = true
      return maybeExit()
    },
    isIdle() {
      return maybeExit()
    },
  }
}

function runStdioServer() {
  const parser = createMessageParser((message) => process.stdout.write(message))
  process.stdin.on("data", (chunk) => parser.push(chunk))
  process.stdin.on("end", () => {
    parser.end()
    const waitForIdle = () => {
      if (parser.isIdle()) process.exit(0)
      else setTimeout(waitForIdle, 10)
    }
    waitForIdle()
  })
  process.on("uncaughtException", (error) => {
    log(error instanceof Error ? error.stack || error.message : String(error))
  })
  process.on("unhandledRejection", (reason) => {
    log(reason instanceof Error ? reason.stack || reason.message : String(reason))
  })
}

module.exports = {
  createMessageParser,
  handleRequest,
  runStdioServer,
}
