import "server-only"

/**
 * 号池「可读性」探测。
 *
 * 账号能拿来转发，除了没被禁用/封禁/限频，还必须读得出**未过期**的登录态：
 * 过期账号发出去的请求必然失败，而且换一个号就能继续服务，所以选择阶段就该跳过。
 *
 * 这里只回答「这个 uid 现在能不能用」，不做任何状态写入——用户重新登录后
 * 过期账号应当立刻自动恢复，不能被某个持久标记挡住。
 */

export interface ReadablePoolAccount<T> {
  uid: string
  account: T
}

/**
 * 按给定顺序读出第一个可用账号；凭据读不出来（过期、文件损坏、解不开）就换下一个。
 *
 * 全部候选都读不出来时抛出**最后一次**读盘错误，让调用方拿到最贴近根因的原因，
 * 而不是笼统的「没有可用账号」。
 */
export async function firstReadableAccount<T>(
  uids: readonly string[],
  readAccount: (uid: string) => Promise<T>,
): Promise<ReadablePoolAccount<T>> {
  let lastError: unknown
  for (const uid of uids) {
    try {
      return { uid, account: await readAccount(uid) }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error("WorkBuddy 号池里没有可用账号")
}

/** 轮换用的宽松版本：全部候选都不可用时返回 undefined，由调用方决定怎么报错。 */
export async function firstReadableUid<T>(
  uids: readonly string[],
  readAccount: (uid: string) => Promise<T>,
): Promise<string | undefined> {
  if (uids.length === 0) return undefined
  try {
    return (await firstReadableAccount(uids, readAccount)).uid
  } catch {
    return undefined
  }
}
