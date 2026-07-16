const COMPACT_NUMBER_FORMAT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
  useGrouping: false,
})

const INTEGER_FORMAT = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 0,
})

export function formatTokenCount(value: number | undefined) {
  if (value == null || !Number.isFinite(value)) return "—"

  const absoluteValue = Math.abs(value)
  if (absoluteValue >= 999_950) {
    return `${COMPACT_NUMBER_FORMAT.format(value / 1_000_000)}M`
  }
  if (absoluteValue >= 1_000) {
    return `${COMPACT_NUMBER_FORMAT.format(value / 1_000)}K`
  }
  return INTEGER_FORMAT.format(value)
}

export function formatDurationSeconds(durationMs: number | undefined) {
  if (durationMs == null || !Number.isFinite(durationMs)) return "—"
  return `${(durationMs / 1_000).toFixed(1)}s`
}

export function formatIntegerCount(value: number) {
  return INTEGER_FORMAT.format(value)
}
