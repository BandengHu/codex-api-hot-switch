/**
 * 服务器启动钩子。
 *
 * 每日领积分原本只挂在 `GET /api/console` 上：进程重启后必须有人打开控制台，
 * 巡检才会起来。这里在进程启动时直接拉起，保证每天自己跑。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  if (process.env.CODEX_HOT_SWITCH_SERVER_UI !== "1") return

  const { startDailyScheduler } = await import(
    "@/lib/server/workbuddy/daily-scheduler"
  )
  startDailyScheduler()

  // 积分账本早先没有裁剪，历史文件只会一路变大（本地实测 14 天 3.7 万行）。
  // 启动时按账号各收缩一次，把遗留账本拉回保留期内；日常追加由
  // appendWorkbuddyCreditLedger 每 200 行自动整理一次。
  const { compactWorkbuddyCreditLedger } = await import(
    "@/lib/server/workbuddy/credit-ledger"
  )
  const { accountDataDirPath, listAccounts } = await import(
    "@/lib/server/accounts-store"
  )
  void listAccounts()
    .then((accounts) =>
      Promise.allSettled(
        accounts.map((account) => compactWorkbuddyCreditLedger(accountDataDirPath(account.id))),
      ),
    )
    .catch(() => undefined)
}
