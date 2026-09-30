import "server-only"

import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { ProxyTarget } from "./common"
import { readDecodedResponseText } from "./content-encoding"
import { extractTokenUsage } from "./token-usage"

type AnyRecord = Record<string, any>

interface QwenResponsesDiagnosticOptions {
  target: ProxyTarget
  startedAt: number
  statusCode: number
  rewrittenBody: unknown
}

interface FrameInfo {
  event: string
  type: string
  hasUsage: boolean
  hasOutputText: boolean
  hasToolCall: boolean
  hasReasoning: boolean
  terminal?: "completed" | "failed" | "done"
}

function defaultDataDir() {
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
      "codex-api-hot-switch",
      "data",
    )
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "codex-api-hot-switch", "data")
  }
  return join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "codex-api-hot-switch",
    "data",
  )
}

function diagnosticsDir() {
  return join(
    process.env.CODEX_HOT_SWITCH_DATA_DIR || defaultDataDir(),
    "logs",
    "qwen-responses-diagnostics",
  )
}

function diagnosticsIndexPath() {
  return join(
    process.env.CODEX_HOT_SWITCH_DATA_DIR || defaultDataDir(),
    "logs",
    "qwen-responses-diagnostics.jsonl",
  )
}

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function safeText(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

export function isQwenResponsesDiagnosticTarget(target: ProxyTarget) {
  if (target.provider.protocol !== "openai-responses") return false
  const hint = [
    target.modelId,
    target.requestedModel,
    target.provider.name,
    target.provider.baseUrl,
  ].join(" ").toLowerCase()
  return (
    hint.includes("qwen") ||
    hint.includes("qwq") ||
    hint.includes("qvq") ||
    hint.includes("dashscope") ||
    hint.includes("bailian") ||
    hint.includes("aliyuncs") ||
    hint.includes("千问") ||
    hint.includes("百炼")
  )
}

export async function writeQwenResponsesStreamFallthroughDiagnostic(params: {
  target: ProxyTarget
  startedAt: number
  path: string
  statusCode: number
  upstream: Response
  rawBody: unknown
  rewrittenBody: unknown
  adapter: unknown
}) {
  if (!isQwenResponsesDiagnosticTarget(params.target)) return null

  const text = await readDecodedResponseText(params.upstream.clone())
  const id = `qwen-fallthrough-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
  const dir = diagnosticsDir()
  const indexPath = diagnosticsIndexPath()
  const rawResponsePath = join(dir, `${id}-upstream.sse`)
  const rawRequestPath = join(dir, `${id}-raw-request.json`)
  const rewrittenPath = join(dir, `${id}-rewritten-request.json`)
  const metaPath = join(dir, `${id}-meta.json`)
  const meta = {
    id,
    kind: "stream_fallthrough",
    timestamp: new Date().toISOString(),
    requestTimestamp: new Date(params.startedAt).toISOString(),
    durationMs: Date.now() - params.startedAt,
    path: params.path,
    statusCode: params.statusCode,
    contentType: params.upstream.headers.get("content-type"),
    codexModel: params.target.requestedModel,
    finalProviderId: params.target.provider.id,
    finalProviderName: params.target.provider.name,
    finalModelId: params.target.modelId,
    protocol: params.target.provider.protocol,
    rawResponsesPassthrough: params.target.provider.rawResponsesPassthrough === true,
    requestStream: isObject(params.rawBody) ? params.rawBody.stream === true : false,
    rewrittenStream: isObject(params.rewrittenBody) ? params.rewrittenBody.stream === true : false,
    adapter: params.adapter,
    upstreamTextLength: text.length,
    upstreamSummary: summarizeRawSse(text),
    rawResponsePath,
    rawRequestPath,
    rewrittenRequestPath: rewrittenPath,
    metaPath,
  }

  await mkdir(dirname(indexPath), { recursive: true })
  await mkdir(dir, { recursive: true })
  await Promise.all([
    writeFile(rawResponsePath, text, "utf8"),
    writeFile(rawRequestPath, jsonText(params.rawBody), "utf8"),
    writeFile(rewrittenPath, jsonText(params.rewrittenBody), "utf8"),
    writeFile(metaPath, jsonText(meta), "utf8"),
  ])
  await appendFile(indexPath, `${JSON.stringify(meta)}\n`, "utf8")
  return { text, meta }
}

function jsonText(value: unknown) {
  try {
    return JSON.stringify(value, null, 2)
  } catch (error) {
    return error instanceof Error ? `[Unserializable: ${error.message}]` : "[Unserializable]"
  }
}

function parseSseFrames(text: string) {
  return String(text || "")
    .trimStart()
    .replace(/^\uFEFF/, "")
    .split(/\r?\n\r?\n/)
    .map((frame) => {
      let event = ""
      const data: string[] = []
      for (const rawLine of frame.split(/\r?\n/)) {
        const line = rawLine.trimStart()
        if (line.startsWith("event:")) event = line.slice(6).trim()
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
      }
      return { event, payload: data.join("\n") }
    })
    .filter((frame) => frame.payload)
}

function frameInfo(frame: { event: string; payload: string }): FrameInfo {
  if (frame.payload === "[DONE]") {
    return {
      event: frame.event,
      type: "[DONE]",
      hasUsage: false,
      hasOutputText: false,
      hasToolCall: false,
      hasReasoning: false,
      terminal: "done",
    }
  }
  let data: unknown
  try {
    data = JSON.parse(frame.payload)
  } catch {
    return {
      event: frame.event,
      type: "",
      hasUsage: false,
      hasOutputText: false,
      hasToolCall: false,
      hasReasoning: false,
    }
  }
  const record = isObject(data) ? data : {}
  const response = isObject(record.response) ? record.response : record
  const item = isObject(record.item) ? record.item : undefined
  const type = safeText(record.type || frame.event)
  const output = Array.isArray(response.output) ? response.output : []
  const allItems = item ? [item, ...output] : output
  const hasOutputText =
    type === "response.output_text.delta" ||
    type === "response.output_text.done" ||
    allItems.some((entry) =>
      isObject(entry) &&
      entry.type === "message" &&
      Array.isArray(entry.content) &&
      entry.content.some((part: unknown) =>
        isObject(part) &&
        part.type === "output_text" &&
        typeof part.text === "string" &&
        part.text.length > 0,
      ),
    )
  const hasToolCall = allItems.some((entry) =>
    isObject(entry) &&
    (
      entry.type === "function_call" ||
      entry.type === "custom_tool_call" ||
      entry.type === "web_search_call"
    ),
  )
  const hasReasoning =
    type.startsWith("response.reasoning") ||
    allItems.some((entry) => isObject(entry) && entry.type === "reasoning")
  const terminal =
    type === "response.completed" || type === "response.done" || response.status === "completed"
      ? "completed"
      : type === "response.failed" || response.status === "failed"
        ? "failed"
        : undefined
  return {
    event: frame.event,
    type,
    hasUsage: Boolean(extractTokenUsage(data)),
    hasOutputText,
    hasToolCall,
    hasReasoning,
    terminal,
  }
}

function summarizeRawSse(text: string) {
  const summary = {
    events: new Map<string, number>(),
    types: new Map<string, number>(),
    completed: false,
    failed: false,
    done: false,
    hasUsage: false,
    hasOutputText: false,
    hasToolCall: false,
    hasReasoning: false,
  }
  for (const frame of parseSseFrames(text)) {
    const info = frameInfo(frame)
    if (info.event) summary.events.set(info.event, (summary.events.get(info.event) || 0) + 1)
    if (info.type) summary.types.set(info.type, (summary.types.get(info.type) || 0) + 1)
    summary.hasUsage ||= info.hasUsage
    summary.hasOutputText ||= info.hasOutputText
    summary.hasToolCall ||= info.hasToolCall
    summary.hasReasoning ||= info.hasReasoning
    if (info.terminal === "completed") summary.completed = true
    else if (info.terminal === "failed") summary.failed = true
    else if (info.terminal === "done") summary.done = true
  }
  return {
    ...summary,
    events: Object.fromEntries(summary.events),
    types: Object.fromEntries(summary.types),
  }
}

function shouldWriteDiagnostic(summary: ReturnType<typeof summarizeRawSse>, aborted: boolean) {
  if (aborted) return true
  if (!summary.completed) return true
  if (!summary.hasUsage) return true
  return !summary.hasOutputText && !summary.hasToolCall
}

async function writeDiagnostic(
  options: QwenResponsesDiagnosticOptions,
  rawSse: string,
  summary: ReturnType<typeof summarizeRawSse>,
  aborted: boolean,
  reason: unknown,
) {
  if (!shouldWriteDiagnostic(summary, aborted)) return
  const id = `qwen-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
  const dir = diagnosticsDir()
  const indexPath = diagnosticsIndexPath()
  const rawSsePath = join(dir, `${id}-raw.sse`)
  const rewrittenPath = join(dir, `${id}-rewritten.json`)
  const metaPath = join(dir, `${id}-meta.json`)
  const meta = {
    id,
    timestamp: new Date().toISOString(),
    requestTimestamp: new Date(options.startedAt).toISOString(),
    statusCode: options.statusCode,
    durationMs: Date.now() - options.startedAt,
    aborted,
    abortReason: reason == null ? null : String(reason),
    codexModel: options.target.requestedModel,
    finalProviderId: options.target.provider.id,
    finalProviderName: options.target.provider.name,
    finalModelId: options.target.modelId,
    rawSseLength: rawSse.length,
    rawSsePath,
    rewrittenRequestPath: rewrittenPath,
    summary,
  }
  await mkdir(dirname(indexPath), { recursive: true })
  await mkdir(dir, { recursive: true })
  await Promise.all([
    writeFile(rawSsePath, rawSse, "utf8"),
    writeFile(rewrittenPath, jsonText(options.rewrittenBody), "utf8"),
    writeFile(metaPath, jsonText(meta), "utf8"),
  ])
  await appendFile(indexPath, `${JSON.stringify(meta)}\n`, "utf8")
}

export function createQwenResponsesDiagnosticStream(
  stream: ReadableStream<Uint8Array>,
  options: QwenResponsesDiagnosticOptions,
) {
  if (!isQwenResponsesDiagnosticTarget(options.target)) return stream

  const decoder = new TextDecoder()
  const chunks: string[] = []
  const reader = stream.getReader()
  let closed = false

  async function finish(aborted: boolean, reason?: unknown) {
    if (closed) return
    closed = true
    const tail = decoder.decode()
    if (tail) chunks.push(tail)
    const rawSse = chunks.join("")
    const summary = summarizeRawSse(rawSse)
    await writeDiagnostic(options, rawSse, summary, aborted, reason).catch(() => undefined)
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read()
        if (done) {
          await finish(false)
          controller.close()
          return
        }
        if (value?.length) chunks.push(decoder.decode(value, { stream: true }))
        if (value) controller.enqueue(value)
      } catch (error) {
        await finish(true, error)
        controller.error(error)
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        await finish(true, reason)
      }
    },
  })
}
