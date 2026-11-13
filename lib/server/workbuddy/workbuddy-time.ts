import "server-only"

const SHANGHAI_TIME_ZONE = "Asia/Shanghai"
const shanghaiClock = new Intl.DateTimeFormat("en-US", {
  timeZone: SHANGHAI_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
})

function shanghaiParts(now: Date) {
  const parts = shanghaiClock.formatToParts(now)
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ""
  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    hour: Number(read("hour")),
  }
}

/** 上海时区的自然日，格式为 YYYY-MM-DD。 */
export function formatShanghaiDay(now = new Date()) {
  const { year, month, day } = shanghaiParts(now)
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

/** 夜猫子窗口：上海时区 23:00-07:59。 */
export function isNightWindow(now = new Date()) {
  const { hour } = shanghaiParts(now)
  return hour >= 23 || hour < 8
}

/** 夜猫子每晚只成功的最后一次执行时间；同一晚失败不占掉重试窗口。 */
export function nightOwlShouldRun(now: Date, lastRunAt?: string) {
  if (!isNightWindow(now)) return false
  const last = Date.parse(lastRunAt ?? "")
  if (!Number.isFinite(last)) return true
  return workbuddyNightKey(new Date(last)) !== workbuddyNightKey(now)
}

/**
 * 夜猫子的“晚”键。
 *
 * 23:00-23:59 归当天，00:00-07:59 归前一天；这样跨午夜只算同一晚，
 * 不会在一次夜间窗口内重复上报两次。
 */
export function workbuddyNightKey(now = new Date()) {
  const { year, month, day, hour } = shanghaiParts(now)
  const dayNumber = Date.UTC(year, month - 1, day)
  const keyDay = hour < 8 ? dayNumber - 86_400_000 : dayNumber
  const value = new Date(keyDay)
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`
}
