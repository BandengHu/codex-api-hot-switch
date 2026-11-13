import "server-only"

import assert from "node:assert/strict"
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { RequestLog } from "@/lib/types"
import {
  ledgerEntryFromLog,
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
