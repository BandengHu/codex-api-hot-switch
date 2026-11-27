import "server-only"

import assert from "node:assert/strict"
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { RequestLog } from "@/lib/types"
import {
  compactWorkbuddyCreditLedger,
  ledgerEntryFromLog,
  pruneCreditLedgerEntries,
  summarizeWorkbuddyCreditsByUid,
} from "./credit-ledger"

function log(values: Partial<RequestLog> = {}): RequestLog {
  return {
    id: "log-credit",
    timestamp: "2026-11-13T02:00:00.000Z",
    codexModel: "gpt-5.6-terra",
    finalProviderId: "workbuddy",
    finalModelId: "deepseek-v4.1-flash",
    reasoning: "off",
    statusCode: 200,
    durationMs: 1000,
    rawRequest: "",
    rewrittenRequest: "",
    responseSummary: "",
    ...values,
  }
}

test("积分账本保留真实小数和账号归属", () => {
  assert.deepEqual(
    ledgerEntryFromLog(log({
      workbuddyUid: "account-a",
      workbuddyRealm: "cn",
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
        credit: 0.75,
      },
    })),
    {
      timestamp: "2026-11-13T02:00:00.000Z",
      requestId: "log-credit",
      uid: "account-a",
      realm: "cn",
      modelId: "deepseek-v4.1-flash",
      statusCode: 200,
      creditKnown: true,
      credit: 0.75,
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
    },
  )
})

test("上游没返回 credit 时记未知，不按 token 估算", () => {
  const entry = ledgerEntryFromLog(log({
    workbuddyUid: "account-a",
    workbuddyRealm: "cn",
    tokenUsage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
  }))
  assert.equal(entry?.creditKnown, false)
  assert.equal(entry?.credit, null)
})

test("非 WorkBuddy 请求不进入积分账本", () => {
  assert.equal(ledgerEntryFromLog(log()), undefined)
})

test("积分汇总按上海自然日统计、去重，并排除未知积分", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "switchgate-credit-ledger-"))
  try {
    const entries = [
      ledgerEntryFromLog(log({
        id: "known",
        timestamp: "2026-11-12T16:00:00.000Z",
        workbuddyUid: "summary-account",
        workbuddyRealm: "cn",
        tokenUsage: {},
      })),
      ledgerEntryFromLog(log({
        id: "unknown",
        timestamp: "2026-11-13T15:59:59.999Z",
        workbuddyUid: "summary-account",
        workbuddyRealm: "cn",
        tokenUsage: {},
      })),
      ledgerEntryFromLog(log({
        id: "known",
        timestamp: "2026-11-12T16:00:00.000Z",
        workbuddyUid: "summary-account",
        workbuddyRealm: "cn",
        tokenUsage: { credit: 0.25 },
      })),
      ledgerEntryFromLog(log({
        id: "previous-day",
        timestamp: "2026-11-12T15:59:59.999Z",
        workbuddyUid: "summary-account",
        workbuddyRealm: "cn",
        tokenUsage: { credit: 9 },
      })),
      ledgerEntryFromLog(log({
        id: "global",
        timestamp: "2026-11-13T02:00:00.000Z",
        workbuddyUid: "summary-account",
        workbuddyRealm: "global",
        tokenUsage: { credit: 8 },
      })),
    ]
    const telemetryDir = join(dataDir, "telemetry")
    await mkdir(telemetryDir, { recursive: true })
    await appendFile(
      join(telemetryDir, "workbuddy-credit-usage.jsonl"),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    )
    const summary = await summarizeWorkbuddyCreditsByUid("2026-11-13", { dataDir })
    assert.deepEqual(summary["summary-account"], {
      recordedRequests: 2,
      knownCredits: 1,
      unknownCredits: 1,
      creditTotal: 0.25,
    })
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

const DAY_MS = 24 * 60 * 60 * 1000

function ledgerEntry(id: string, at: number, uid = "account-a") {
  return {
    timestamp: new Date(at).toISOString(),
    requestId: id,
    uid,
    realm: "cn" as const,
    modelId: "deepseek-v4.1-flash",
    statusCode: 200,
    creditKnown: true,
    credit: 1,
    inputTokens: 10,
    outputTokens: 1,
    totalTokens: 11,
  }
}

test("超过保留期的账本行会被裁掉，期内保留", () => {
  const now = Date.parse("2026-11-27T12:00:00.000Z")
  const entries = [
    ledgerEntry("old", now - 60 * DAY_MS),
    ledgerEntry("edge-out", now - 46 * DAY_MS),
    ledgerEntry("edge-in", now - 44 * DAY_MS),
    ledgerEntry("fresh", now - 1 * DAY_MS),
  ]
  const kept = pruneCreditLedgerEntries(entries, now).map((entry) => entry.requestId)
  assert.deepEqual(kept.sort(), ["edge-in", "fresh"])
})

test("同一 requestId 只留一条，口径与汇总去重一致", () => {
  const now = Date.parse("2026-11-27T12:00:00.000Z")
  const first = ledgerEntry("dup", now - 2 * DAY_MS)
  const second = { ...ledgerEntry("dup", now - 1 * DAY_MS), credit: 2 }
  const kept = pruneCreditLedgerEntries([first, second], now)
  assert.equal(kept.length, 1)
  assert.equal(kept[0].credit, 2, "重复行应当保留最后写入的那条")
})

test("条数兜底上限生效时保留最新的行", () => {
  const now = Date.parse("2026-11-27T12:00:00.000Z")
  const entries = Array.from({ length: 105 }, (_item, index) =>
    ledgerEntry(`log-${index}`, now - (105 - index) * 1000),
  )
  const kept = pruneCreditLedgerEntries(entries, now, 100)
  assert.equal(kept.length, 100)
  assert.equal(kept[0].requestId, "log-104", "最新的行必须在最前面")
  assert.equal(kept[kept.length - 1].requestId, "log-5")
})

test("保留期是主策略：45 天内的高频账号不会被条数上限提前截断", () => {
  const now = Date.parse("2026-11-27T12:00:00.000Z")
  // 按本地实测每天约 2600 条，模拟 44 天共 11.4 万条。
  const perDay = 2600
  const days = 44
  const entries = Array.from({ length: perDay * days }, (_item, index) =>
    ledgerEntry(`log-${index}`, now - 1 * DAY_MS - index * 1000),
  )
  const kept = pruneCreditLedgerEntries(entries, now)
  assert.equal(kept.length, perDay * days, "45 天内的行必须全部保留")
})

test("主动收缩会把过期行真正从磁盘删掉", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "switchgate-credit-compact-"))
  const telemetryDir = join(dataDir, "telemetry")
  const ledgerFile = join(telemetryDir, "workbuddy-credit-usage.jsonl")
  try {
    await mkdir(telemetryDir, { recursive: true })
    const now = Date.now()
    const rows = [
      ledgerEntry("stale", now - 60 * DAY_MS),
      ledgerEntry("middle", now - 20 * DAY_MS),
      ledgerEntry("recent", now - 1 * DAY_MS),
    ]
    await appendFile(
      ledgerFile,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    )

    await compactWorkbuddyCreditLedger(dataDir)

    const text = await readFile(ledgerFile, "utf8")
    const remaining = text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line).requestId)
    assert.deepEqual(remaining, ["middle", "recent"])
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
