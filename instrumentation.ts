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
}
