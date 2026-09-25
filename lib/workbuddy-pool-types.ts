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
