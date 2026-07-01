import "server-only"

import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, relative } from "node:path"
import type { RequestLog } from "@/lib/types"

const CHINESE_LANGUAGE_POLICY_MARKER = "必须使用用户的主要对话语言"
const OLD_ENGLISH_LANGUAGE_POLICY_MARKER = "Use the user's primary conversational language"
const CJK_RE = /[\u3400-\u9fff]/
const ENGLISH_ACTION_RE =
  /\b(?:I'll|I will|Let me|I'm going to|I am going to|Now I'll|Now I will|I'll inspect|I'll run|I'll check|I'll read|I'll update|I'll add|I'll verify|I'll look|I'll use|Now add|Now wire|Now capture|Let me read|Let me inspect|Let me check|Let me run)\b[^"\n\r]{0,160}/gi

interface DiagnosticSource {
  rawBody?: unknown
  rewrittenBody?: unknown
  responseSummary?: string
  expectChinesePolicy?: boolean
}

const rawSources = new WeakMap<RequestLog, DiagnosticSource>()

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

function diagnosticsPath() {
  return join(
    process.env.CODEX_HOT_SWITCH_DATA_DIR || defaultDataDir(),
    "logs",
    "language-policy-missing-diagnostics.jsonl",
  )
}

function diagnosticsDir() {
  return join(
    process.env.CODEX_HOT_SWITCH_DATA_DIR || defaultDataDir(),
    "logs",
    "language-policy-missing-diagnostics",
  )
}

function compactMatches(text: string) {
  return Array.from(text.matchAll(ENGLISH_ACTION_RE))
    .map((match) => match[0].replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 8)
}

function fullText(value: unknown) {
  if (typeof value === "string") return value
  if (value == null) return ""
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(
      value,
      (_key, child) => {
        if (child && typeof child === "object") {
          if (seen.has(child)) return "[Circular]"
          seen.add(child)
        }
        return child
      },
      2,
    )
  } catch (error) {
    return error instanceof Error ? `[Unserializable: ${error.message}]` : "[Unserializable]"
  }
}

function containsTextDeep(value: unknown, text: string, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") return value.includes(text)
  if (!value || typeof value !== "object") return false
  if (seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) {
    return value.some((item) => containsTextDeep(item, text, seen))
  }
  return Object.values(value).some((item) => containsTextDeep(item, text, seen))
}

function safeFileId(id: string) {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_")
}

function relativeFromDataDir(path: string) {
  return relative(process.env.CODEX_HOT_SWITCH_DATA_DIR || defaultDataDir(), path)
}

export function registerLanguagePolicyDiagnosticSource(
  log: RequestLog,
  source: DiagnosticSource,
) {
  rawSources.set(log, source)
}

export async function appendLanguagePolicyDiagnostic(log: RequestLog) {
  const source = rawSources.get(log)
  if (source?.expectChinesePolicy === false) return

  const rawBody = source?.rawBody ?? log.rawRequest
  const rewrittenBody =
    source && Object.hasOwn(source, "rewrittenBody")
      ? source.rewrittenBody
      : log.rewrittenRequest || ""
  if (rewrittenBody == null || rewrittenBody === "") return
  const rewrittenHasChinesePolicy = containsTextDeep(
    rewrittenBody,
    CHINESE_LANGUAGE_POLICY_MARKER,
  )
  if (rewrittenHasChinesePolicy) return

  const rawRequest = fullText(rawBody)
  const rewrittenRequest = fullText(rewrittenBody)
  const responseSummary = source?.responseSummary || log.responseSummary || ""
  const englishActionMatches = compactMatches(responseSummary)
  const indexFile = diagnosticsPath()
  const entryDir = diagnosticsDir()
  const fileId = safeFileId(log.id)
  const rawRequestFile = join(entryDir, `${fileId}-raw.json`)
  const rewrittenRequestFile = join(entryDir, `${fileId}-rewritten.json`)
  const responseSummaryFile = join(entryDir, `${fileId}-response.txt`)
  const rawRequestHasChinesePolicy = rawRequest.includes(CHINESE_LANGUAGE_POLICY_MARKER)
  const rawRequestHasOldEnglishPolicy = rawRequest.includes(OLD_ENGLISH_LANGUAGE_POLICY_MARKER)
  const rewrittenHasOldEnglishPolicy = rewrittenRequest.includes(OLD_ENGLISH_LANGUAGE_POLICY_MARKER)
  const record = {
    schemaVersion: 3,
    id: log.id,
    timestamp: new Date().toISOString(),
    requestTimestamp: log.timestamp,
    codexModel: log.codexModel,
    finalProviderId: log.finalProviderId,
    finalModelId: log.finalModelId,
    statusCode: log.statusCode,
    durationMs: log.durationMs,
    error: log.error || null,
    rawRequestHasChinese: CJK_RE.test(rawRequest),
    rewrittenRequestHasChinese: CJK_RE.test(rewrittenRequest),
    rawRequestHasChinesePolicy,
    rawRequestHasOldEnglishPolicy,
    rewrittenHasChinesePolicy,
    rewrittenHasOldEnglishPolicy,
    chinesePolicySource: rawRequestHasChinesePolicy
      ? "raw_request"
      : rewrittenHasChinesePolicy
        ? "proxy_rewrite"
        : "missing",
    oldEnglishPolicySource: rawRequestHasOldEnglishPolicy
      ? "raw_request"
      : rewrittenHasOldEnglishPolicy
        ? "proxy_rewrite"
        : "none",
    responseHasEnglishActionText: englishActionMatches.length > 0,
    englishActionMatches,
    possibleMissingPolicy:
      CJK_RE.test(rawRequest) &&
      !rewrittenHasChinesePolicy &&
      !rewrittenRequest.includes("OpenAI Responses raw stream passthrough"),
    rawRequestLength: rawRequest.length,
    rewrittenRequestLength: rewrittenRequest.length,
    responseSummaryLength: responseSummary.length,
    rawRequestFile,
    rewrittenRequestFile,
    responseSummaryFile,
    relativeRawRequestFile: relativeFromDataDir(rawRequestFile),
    relativeRewrittenRequestFile: relativeFromDataDir(rewrittenRequestFile),
    relativeResponseSummaryFile: relativeFromDataDir(responseSummaryFile),
  }
  await mkdir(dirname(indexFile), { recursive: true })
  await mkdir(entryDir, { recursive: true })
  await Promise.all([
    writeFile(rawRequestFile, rawRequest, "utf8"),
    writeFile(rewrittenRequestFile, rewrittenRequest, "utf8"),
    writeFile(responseSummaryFile, responseSummary, "utf8"),
  ])
  await appendFile(indexFile, `${JSON.stringify(record)}\n`, "utf8")
}
