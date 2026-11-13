import "server-only"

import { accountDataDir } from "@/lib/server/data-root"

/**
 *号池账号级任务互斥。
 *
 *照搬 `workbuddy2api-panel`（GitHub开源项目）的 per-account锁：同一账号的单任务
 *动作与「一键全部」共用一把锁，重复触发直接拒绝，而不是并发跑两遍。
 *
 *为什么要锁：动作本身幂等（已 claimed的任务会被编排层跳过），但 `expert_*` /
 * `skill_1` / `chat_5`每轮都含真实对话，重跑一遍纯属浪费上游配额与风控额度。
 *不同账号之间不互斥（可并行）。
 *
 *锁只活在进程内：Next.js route handler跑在同一 Node进程里，够用；这也不是
 *分布式锁，多实例部署时各实例独立持锁。
 */

const running = new Set<string>()

/**
 * 锁键：同一 WorkBuddy uid 在管理员与普通账号的号池里可能重复，
 * 多账号部署时必须按账号目录隔离，否则两个账号会自动互相挡住。
 */
function lockKey(uid: string) {
  return `${accountDataDir() ?? "local"}\u0000${uid}`
}

/**尝试占用账号锁；该账号已有任务在跑时返回 false。 */
export function tryLockTaskAccount(uid: string): boolean {
 const key = lockKey(uid)
 if (running.has(key)) return false
 running.add(key)
 return true
}

/**释放账号锁（与 `tryLockTaskAccount`配对，必须在 finally里调用）。 */
export function unlockTaskAccount(uid: string) {
 running.delete(lockKey(uid))
}

/**占用中的账号快照（诊断用）。 */
export function busyTaskAccounts(): string[] {
 return [...running].map((key) => key.slice(key.indexOf("\u0000") + 1))
}
