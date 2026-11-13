import "server-only"

import assert from "node:assert/strict"
import test from "node:test"

import { summaryCreditTotals, fallbackCreditTotals } from "./credit-summary"

test("summary 的 Packages 是累计发放和已用积分的权威口径", () => {
  assert.deepEqual(summaryCreditTotals([
    { CycleTotalCapacity: 2400, CycleRemainCapacity: 1416, CycleUsedCapacity: 984 },
    { CycleTotalCapacity: 2100, CycleRemainCapacity: 2100, CycleUsedCapacity: 0 },
  ]), {
    remain: 3516,
    used: 984,
    size: 4500,
  })
})

test("summary 保留已用完或过期的历史包，不因容量为0而漏算", () => {
  assert.deepEqual(summaryCreditTotals([
    { CycleTotalCapacity: 300, CycleRemainCapacity: 300, CycleUsedCapacity: 0 },
    { CycleTotalCapacity: 300, CycleRemainCapacity: 0, CycleUsedCapacity: 300 },
    { CycleTotalCapacity: 300, CycleRemainCapacity: 0, CycleUsedCapacity: 300 },
  ]), {
    remain: 300,
    used: 600,
    size: 900,
  })
})

test("summary 缺容量字段时才返回 undefined，让调用方回退明细", () => {
  assert.equal(summaryCreditTotals([
    { PackageCode: "without-capacity" },
    { Status: 3 },
  ]), undefined)
  assert.equal(summaryCreditTotals(undefined), undefined)
})

test("summary 明确给出 0 容量包时仍是有效口径", () => {
  assert.deepEqual(summaryCreditTotals([
    { CycleTotalCapacity: 0, CycleRemainCapacity: 0, CycleUsedCapacity: 0 },
  ]), {
    remain: 0,
    used: 0,
    size: 0,
  })
})

test("明细回退兼容周期包与一次性包，并修正已用值", () => {
  assert.deepEqual(fallbackCreditTotals([
    {
      CycleCapacitySize: 300,
      CycleCapacityRemain: 120,
      CycleCapacityUsed: 180,
    },
    {
      CapacitySize: 500,
      CapacityRemain: 420,
      CapacityUsed: 0,
    },
  ]), {
    remain: 540,
    used: 260,
    size: 800,
  })
})

test("明细非数组或空数据返回全零", () => {
  assert.deepEqual(fallbackCreditTotals(undefined), { remain: 0, used: 0, size: 0 })
  assert.deepEqual(fallbackCreditTotals([]), { remain: 0, used: 0, size: 0 })
})
