"use strict"

const DEFAULT_TIMEOUT_MS = 25_000

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
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

function compactWhitespace(value) {
  return cleanString(value).replace(/\s+/g, " ")
}

function domainFromUrl(value) {
  try {
    return new URL(value).hostname.replace(/^www\./i, "").toLowerCase()
  } catch {
    return null
  }
}

function normalizePublishedAt(value) {
  const text = cleanString(value)
  if (!text) return null
  const timestamp = Date.parse(text)
  if (!Number.isFinite(timestamp)) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  return new Date(timestamp).toISOString()
}

function timeoutMs(envName, fallback = DEFAULT_TIMEOUT_MS) {
  const raw = Number.parseInt(process.env[envName] || "", 10)
  if (Number.isFinite(raw) && raw >= 1000 && raw <= 120_000) return raw
  return fallback
}

function withTimeout(signal, milliseconds) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), milliseconds)
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

async function readFetchResponseText(response, maxBytes, label) {
  if (!response.body) {
    const text = await response.text()
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error(`${label} response exceeded ${maxBytes} bytes`)
    }
    return text
  }

  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error(`${label} response exceeded ${maxBytes} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(output)
}

async function fetchJson(url, options = {}) {
  if (typeof fetch !== "function") {
    throw new Error("This tool requires Node.js 18+ with global fetch support")
  }

  const label = options.label || "request"
  const timeout = withTimeout(options.signal, options.timeoutMs || DEFAULT_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: options.headers,
      body: options.body,
      signal: timeout.signal,
    })
    const body = await readFetchResponseText(
      response,
      options.maxBytes || 512 * 1024,
      label,
    )
    if (!response.ok) {
      throw new Error(`${label} returned HTTP ${response.status}: ${body.slice(0, 500)}`)
    }
    try {
      return JSON.parse(body)
    } catch {
      throw new Error(`${label} returned invalid JSON`)
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${label} timed out`)
    }
    throw error
  } finally {
    timeout.done()
  }
}

module.exports = {
  cleanPositiveInteger,
  cleanString,
  compactWhitespace,
  domainFromUrl,
  fetchJson,
  isObject,
  normalizePublishedAt,
  readFetchResponseText,
  timeoutMs,
  withTimeout,
}
