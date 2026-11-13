import "server-only"

import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { hotSwitchDataDir } from "@/lib/server/state-store"
import type { RequestLog } from "@/lib/types"
import { formatScheduleDay } from "./daily-scheduler"

export interface WorkbuddyCreditLedgerEntry {
  timestamp: string
  requestId: string
  uid: string
  realm: "cn" | "global"
  modelId: string
  statusCode: number
  /** 上游是否明确返回 credit；false 时 credit 必为 null。 */
  creditKnown: boolean
  credit: number | null
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
}

export interface WorkbuddyCreditLedgerSummary {
  recordedRequests: number
  knownCredits: number
  unknownCredits: number
  creditTotal: number
}

export type WorkbuddyCreditSummariesByUid =
  Record<string, WorkbuddyCreditLedgerSummary>

export interface WorkbuddyCreditLedgerOptions {
  dataDir?: string
}

function ledgerPath(dataDir = hotSwitchDataDir()) {
  return join(dataDir, "telemetry", "workbuddy-credit-usage.jsonl")
}

let writeQueue: Promise<unknown> = Promise.resolve()

function enqueueWrite<T>(task: () => Promise<T>) {
  const run = writeQueue.catch(() => undefined).then(task)
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null
}

export function ledgerEntryFromLog(
  log: RequestLog,
): WorkbuddyCreditLedgerEntry | undefined {
  if (!log.workbuddyUid || !log.workbuddyRealm) return undefined
  const rawCredit = log.tokenUsage?.credit
  const creditKnown =
    typeof rawCredit === "number" && Number.isFinite(rawCredit) && rawCredit >= 0
  return {
    timestamp: log.timestamp,
    requestId: log.id,
    uid: log.workbuddyUid,
    realm: log.workbuddyRealm,
    modelId: log.finalModelId,
    statusCode: log.statusCode,
    creditKnown,
    credit: creditKnown ? rawCredit : null,
    inputTokens: numberOrNull(log.tokenUsage?.inputTokens),
    outputTokens: numberOrNull(log.tokenUsage?.outputTokens),
    totalTokens: numberOrNull(log.tokenUsage?.totalTokens),
  }
}

/** 每个 WorkBuddy 请求只追加一行；缺失 credit 时写 null，不估算。 */
export async function appendWorkbuddyCreditLedger(log: RequestLog) {
  const entry = ledgerEntryFromLog(log)
  if (!entry) return
  await enqueueWrite(async () => {
    const path = ledgerPath()
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8")
  })
}

function normalizeLedgerEntry(value: unknown): WorkbuddyCreditLedgerEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (
    typeof item.timestamp !== "string" ||
    !Number.isFinite(Date.parse(item.timestamp)) ||
    typeof item.requestId !== "string" ||
    typeof item.uid !== "string" ||
    (item.realm !== "cn" && item.realm !== "global") ||
    typeof item.modelId !== "string" ||
    !Number.isFinite(item.statusCode)
  ) {
    return null
  }
  const creditKnown = item.creditKnown === true
  const credit =
    creditKnown && Number.isFinite(item.credit) && Number(item.credit) >= 0
      ? Number(item.credit)
      : null
  return {
    timestamp: item.timestamp,
    requestId: item.requestId,
    uid: item.uid,
    realm: item.realm,
    modelId: item.modelId,
    statusCode: Number(item.statusCode),
    creditKnown: credit !== null,
    credit,
    inputTokens: numberOrNull(item.inputTokens),
    outputTokens: numberOrNull(item.outputTokens),
    totalTokens: numberOrNull(item.totalTokens),
  }
}

async function readEntries(dataDir: string) {
  try {
    const raw = await readFile(ledgerPath(dataDir), "utf8")
    const entries: WorkbuddyCreditLedgerEntry[] = []
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const entry = normalizeLedgerEntry(JSON.parse(line))
        if (entry) entries.push(entry)
      } catch {
        // 单行损坏不能拖垮整份积分账本。
      }
    }
    return entries
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

export async function summarizeWorkbuddyCreditsByUid(
  day: string,
  options: WorkbuddyCreditLedgerOptions = {},
): Promise<WorkbuddyCreditSummariesByUid> {
  await writeQueue.catch(() => undefined)
  const summaries: Record<string, WorkbuddyCreditLedgerSummary> = {}
  const entriesByRequestId = new Map<string, WorkbuddyCreditLedgerEntry>()
  for (const entry of await readEntries(options.dataDir ?? hotSwitchDataDir())) {
    if (!entry.requestId || formatScheduleDay(new Date(entry.timestamp)) !== day) continue
    entriesByRequestId.set(entry.requestId, entry)
  }
  for (const entry of entriesByRequestId.values()) {
    if (entry.realm !== "cn") continue
    const summary = summaries[entry.uid] ?? {
      recordedRequests: 0,
      knownCredits: 0,
      unknownCredits: 0,
      creditTotal: 0,
    }
    summary.recordedRequests += 1
    if (entry.credit === null) {
      summary.unknownCredits += 1
    } else {
      summary.knownCredits += 1
      summary.creditTotal += entry.credit
    }
    summaries[entry.uid] = summary
  }
  return summaries
}
