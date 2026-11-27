import "server-only"

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises"
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

/**
 * 积分账本的保留口径。
 *
 * 账本按「每个请求一行」追加，早先没有裁剪，文件只会一路变大：本地实测
 * 14 天已经 3.7 万行 / 9.8MB，照这个速率三年约 77 万行，而号池页面每次
 * 打开都要把整份文件读进来再过滤当天。
 *
 * 界面只读当天数据，这里留 45 天是为了回溯对账，与 token 统计的
 * DAILY_ROLLUP_RETENTION_DAYS 保持同一口径。
 */
const CREDIT_LEDGER_RETENTION_DAYS = 45

/**
 * 条数兜底上限，只防单日海量请求把文件撑爆。
 *
 * 保留期是主策略，这个上限必须放得足够宽，否则高频账号会被它提前截断、
 * 让 45 天保留期形同虚设：本地实测每天约 2600 条，45 天约 12 万条 / 33MB，
 * 因此上限取 20 万条（约 55MB），正常使用永远不会先撞到它。
 */
export const MAX_CREDIT_LEDGER_ENTRIES = 200000

/** 每追加这么多行整理一次，避免每条写入都读全文。 */
const COMPACT_EVERY_APPENDS = 200

/** 各数据目录的追加计数；本地与服务器各账号互不影响。 */
const appendsSinceCompact = new Map<string, number>()

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
export async function appendWorkbuddyCreditLedger(log: RequestLog, dataDir?: string) {
  const entry = ledgerEntryFromLog(log)
  if (!entry) return
  const dir = dataDir ?? hotSwitchDataDir()
  await enqueueWrite(async () => {
    const path = ledgerPath(dataDir)
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8")
    const pending = (appendsSinceCompact.get(dir) ?? 0) + 1
    if (pending < COMPACT_EVERY_APPENDS) {
      appendsSinceCompact.set(dir, pending)
      return
    }
    appendsSinceCompact.set(dir, 0)
    await compactLedgerFile(dir)
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

/**
 * 按保留期 + 条数上限裁剪账本，返回保留的行。
 *
 * 同一次请求可能被写两次（重试/流式收尾），这里按 requestId 只留最后一条，
 * 与 summarizeWorkbuddyCreditsByUid 的去重口径一致，避免裁剪改变统计结果。
 */
export function pruneCreditLedgerEntries(
  entries: WorkbuddyCreditLedgerEntry[],
  now = Date.now(),
  maxEntries = MAX_CREDIT_LEDGER_ENTRIES,
) {
  const cutoff = now - CREDIT_LEDGER_RETENTION_DAYS * 24 * 60 * 60 * 1000
  const byRequestId = new Map<string, WorkbuddyCreditLedgerEntry>()
  for (const entry of entries) {
    const at = Date.parse(entry.timestamp)
    if (!Number.isFinite(at) || at < cutoff) continue
    if (entry.requestId) byRequestId.set(entry.requestId, entry)
  }
  const deduped = Array.from(byRequestId.values())
  const kept = deduped.sort(
    (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
  )
  return kept.slice(0, maxEntries)
}

/** 把账本重写成裁剪后的内容；先写临时文件再 rename，崩溃不会撕坏账本。 */
async function compactLedgerFile(dataDir: string) {
  const path = ledgerPath(dataDir)
  const entries = await readEntries(dataDir)
  const kept = pruneCreditLedgerEntries(entries)
  if (kept.length === entries.length) {
    // 没有需要裁掉的行，不做无谓的整文件重写。
    return
  }
  const tempPath = `${path}.${process.pid}.tmp`
  const text = kept.length
    ? `${kept
        .slice()
        .reverse()
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`
    : ""
  await writeFile(tempPath, text, "utf8")
  await rename(tempPath, path)
}

/**
 * 主动裁剪一次账本。
 *
 * 服务启动时调用，主要用于把历史遗留的未裁剪账本一次性收缩下来；
 * 之后由 appendWorkbuddyCreditLedger 每 COMPACT_EVERY_APPENDS 次自动整理。
 */
export async function compactWorkbuddyCreditLedger(dataDir?: string) {
  const dir = dataDir ?? hotSwitchDataDir()
  await enqueueWrite(() => compactLedgerFile(dir))
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
