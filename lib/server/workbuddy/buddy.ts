import "server-only"

import type { WorkbuddyAccount } from "./account"
import { realmBase, taskFetch, WorkbuddyTaskApiError } from "./api-client"

/**
 *猫猫领养 /旅行（growth域 `activity/growth/buddy/*`）。
 *
 *端点照搬 `workbuddy2api-panel`（GitHub开源项目）实测口径：
 * - `POST buddy/agreement` `{agree:true}`：同意协议（幂等）；
 * - `POST buddy/first`：领养第一只（无猫 +过 conversation门槛时 +300分）；
 * -门槛未达标返回 HTTP400「first_buddy task not completed yet」，属预期行为，
 *调用方按 `isBuddyTaskIncomplete`静默跳过（当日不重试，避免对上游重试轰炸）。
 */

const BUDDY_TASK_INCOMPLETE_MARKER = "first_buddy task not completed yet"

/**同意领养协议（幂等，重复调用无副作用）。 */
export async function agreeBuddyTerms(account: WorkbuddyAccount): Promise<void> {
 const base = realmBase(account)
 await taskFetch(
 account,
 `${base.chat}/activity/growth/buddy/agreement`,
 { method: "POST", body: { agree: true } },
 "同意领养协议",
 )
}

/**领养第一只猫；门槛未达标抛 `isBuddyTaskIncomplete`为真的错误。 */
export async function adoptFirstBuddy(account: WorkbuddyAccount): Promise<void> {
 const base = realmBase(account)
 await taskFetch(
 account,
 `${base.chat}/activity/growth/buddy/first`,
 { method: "POST", body: {} },
 "领取第一只 Buddy",
 )
}

/**判定「领养门槛未达标」：HTTP400 + first_buddy关键词。 */
export function isBuddyTaskIncomplete(error: unknown): boolean {
 if (!(error instanceof WorkbuddyTaskApiError)) return false
 if (error.status !==400) return false
 return String(error.payload ?? error.message).toLowerCase().includes(BUDDY_TASK_INCOMPLETE_MARKER)
}
