/** WorkBuddy 国际版号池（独立于国内站号池）。 */

export interface WorkbuddyGlobalBalance {
  remain: number
  used: number
  size: number
  packs: number
}

export interface WorkbuddyGlobalPoolEntryView {
  uid: string
  nickname: string
  domain: string
  disabled: boolean
  /** 是否是当前转发用的账号（转发到国际站时用它的登录态）。 */
  active: boolean
  balance?: WorkbuddyGlobalBalance
  balanceError?: string
}

/** 国际版上游信息（页面上用于说明当前打的是哪一站）。 */
export interface WorkbuddyGlobalRealm {
  origin: string
  platform: string
}

export interface WorkbuddyGlobalPoolSnapshot {
  entries: WorkbuddyGlobalPoolEntryView[]
  /** 当前生效账号 uid；池空时为 ""。 */
  activeUid: string
  realm: WorkbuddyGlobalRealm
}

export interface WorkbuddyGlobalLoginStart {
  state: string
  url: string
  expiresInMs: number
}

export type WorkbuddyGlobalLoginPoll =
  | { done: false; message: string }
  | {
      done: true
      uid: string
      nickname: string
      credits: number
      creditsTotal: number
    }
