export interface WorkbuddyPoolBalance {
 remain: number
 used: number
 size: number
 packs: number
}

export interface WorkbuddyPoolEntryView {
 uid: string
 nickname: string
 source: "local" | "file"
 disabled: boolean
 balance?: WorkbuddyPoolBalance
 balanceError?: string
 dailyStatus?: {
   lastRunDate: string
   lastResult?: string
   needsRun: boolean
 }
}

/**号池整体视图：条目列表 + 当前生效的转发账号。 */
export interface WorkbuddyPoolSnapshot {
 entries: WorkbuddyPoolEntryView[]
 /**当前转发用的账号 uid（`local` = 本机桌面端登录态）。 */
 activeUid: string
}

export interface WorkbuddyPoolGrowthTask {
 taskCode: string
 title: string
 description: string
 taskDesc: string
 rewardCredit: number
 rewardEnergy: number
 locked: boolean
 target: number
 current: number
 acceptStatus: string
 status: string
 claimable: boolean
 claimed: boolean
}

export interface WorkbuddyAutomationResult {
taskCode: string
status: "done" | "error" | "skipped"
message: string
credit?: number
energy?: number
claimed?: boolean
 progressBefore?: string
 progressAfter?: string
 attempt?: boolean
}

export interface WorkbuddyTaskAction {
 taskCode: string
 desc: string
 attempt: boolean
}

/**「每日领积分」单步结果。 */
export interface WorkbuddyDailyStep {
 key: string
 label: string
 status: "done" | "skipped" | "error"
 message: string
 credit?: number
}

export interface WorkbuddyDailyResult {
 steps: WorkbuddyDailyStep[]
 creditTotal: number
 streakDays?: number
}

export interface WorkbuddyLoginStart {
 state: string
 url: string
 expiresInMs: number
}

export type WorkbuddyLoginPoll =
 | { done: false; message: string }
 | {
 done: true
 uid: string
 nickname: string
 credits: number
 creditsTotal: number
 checkinMessage: string
 }
