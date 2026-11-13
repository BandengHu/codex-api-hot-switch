const SHANGHAI_TIME_ZONE = "Asia/Shanghai"
const DAY_MS = 24 * 60 * 60 * 1000

interface ShanghaiDateParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

function shanghaiParts(value: Date): ShanghaiDateParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value)
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value)
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
  }
}

function calendarDay(value: ShanghaiDateParts) {
  return `${String(value.year).padStart(4, "0")}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`
}

function clock(value: ShanghaiDateParts) {
  return `${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`
}

/**
 * 号池界面使用的恢复时间文案。
 *
 * 相对日期以 Asia/Shanghai 的自然日为准；更远的恢复时间显示月/日，
 * 避免把所有未来时间都误写成“明天”。
 */
export function formatWorkbuddyRateLimitReset(
  resetAt: string,
  now = new Date(),
) {
  const reset = new Date(resetAt)
  if (!Number.isFinite(reset.getTime())) return ""
  const today = calendarDay(shanghaiParts(now))
  const tomorrow = calendarDay(shanghaiParts(new Date(now.getTime() + DAY_MS)))
  const target = calendarDay(shanghaiParts(reset))
  const time = clock(shanghaiParts(reset))
  if (target === today) return `今天 ${time}`
  if (target === tomorrow) return `明天 ${time}`
  return `${shanghaiParts(reset).month}/${shanghaiParts(reset).day} ${time}`
}

/** 状态列的第二行；过期或无效时间不展示，避免把历史限频当成当前状态。 */
export function formatWorkbuddyRateLimitRecovery(
  resetAt: string,
  now = new Date(),
) {
  const reset = Date.parse(resetAt)
  if (!Number.isFinite(reset)) return ""
  const relative = formatWorkbuddyRateLimitReset(resetAt, now)
  if (!relative) return ""
  return reset <= now.getTime() ? `${relative} 已恢复` : `${relative} 恢复`
}
