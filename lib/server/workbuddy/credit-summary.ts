import "server-only"

import { asNumber } from "./api-client"

export interface WorkbuddyCreditTotals {
  remain: number
  used: number
  size: number
}

/**
 * 从官方 resource-summary 的 Packages[] 汇总累计口径。
 *
 * 明细列表会把已用完/过期实例逐渐回收，不能代表累计发放；summary 才是权威累计值。
 * 返回 undefined 表示响应没有可用的容量字段，调用方应回退到明细列表。
 */
export function summaryCreditTotals(packages: unknown): WorkbuddyCreditTotals | undefined {
  if (!Array.isArray(packages)) return undefined
  let remain = 0
  let used = 0
  let size = 0
  let hasCapacity = false

  for (const entry of packages) {
    if (!entry || typeof entry !== "object") continue
    const pkg = entry as Record<string, unknown>
    const packageSize = asNumber(pkg.CycleTotalCapacity)
    const packageRemain = asNumber(pkg.CycleRemainCapacity)
    const packageUsed = asNumber(pkg.CycleUsedCapacity)
    if (packageSize === undefined && packageRemain === undefined && packageUsed === undefined) continue
    hasCapacity = true
    size += Math.max(packageSize ?? 0, 0)
    remain += Math.max(packageRemain ?? 0, 0)
    used += Math.max(packageUsed ?? 0, 0)
  }

  // 上游会返回 0 容量的历史包；只要 Packages[] 存在就是官方口径，不能因为
  // 三项都为 0 就错误回退到可能漏页/漏状态的明细列表。
  return hasCapacity ? { remain, used, size } : undefined
}

/** 明细列表求和：只在 summary 不给容量字段时使用。 */
export function fallbackCreditTotals(packages: unknown): WorkbuddyCreditTotals {
  if (!Array.isArray(packages)) return { remain: 0, used: 0, size: 0 }
  let remain = 0
  let used = 0
  let size = 0

  for (const entry of packages) {
    if (!entry || typeof entry !== "object") continue
    const pkg = entry as Record<string, unknown>
    const cycleSize = asNumber(pkg.CycleCapacitySize) ?? 0
    let packageRemain = 0
    let packageUsed = 0
    let packageSize = 0

    if (cycleSize > 0) {
      packageSize = cycleSize
      packageRemain = Math.min(Math.max(asNumber(pkg.CycleCapacityRemain) ?? 0, 0), cycleSize)
      packageUsed = cycleSize - packageRemain
      const reportedUsed = asNumber(pkg.CycleCapacityUsed) ?? 0
      if (reportedUsed > packageUsed) {
        packageUsed = reportedUsed
        if (cycleSize >= packageUsed) packageRemain = cycleSize - packageUsed
      }
    } else {
      packageRemain = Math.max(asNumber(pkg.CapacityRemain) ?? 0, 0)
      packageUsed = Math.max(asNumber(pkg.CapacityUsed) ?? 0, 0)
      packageSize = Math.max(asNumber(pkg.CapacitySize) ?? 0, 0)
      if (packageUsed === 0 && packageSize > packageRemain) packageUsed = packageSize - packageRemain
    }

    remain += packageRemain
    used += packageUsed
    size += packageSize
  }

  return { remain, used, size }
}
