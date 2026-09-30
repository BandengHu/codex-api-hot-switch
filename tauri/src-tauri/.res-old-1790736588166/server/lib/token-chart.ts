export interface TokenChartValue {
  totalTokens: number
}

interface ChartCoordinate {
  x: number
  y: number
}

function finiteNonNegative(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

export function tokenChartX(index: number, pointCount: number, width: number) {
  if (pointCount <= 1) return width / 2
  return (index / (pointCount - 1)) * width
}

function chartCoordinates(
  points: TokenChartValue[],
  width: number,
  height: number,
  maxValue: number,
) {
  const safeWidth = finiteNonNegative(width)
  const safeHeight = finiteNonNegative(height)
  const safeMax = finiteNonNegative(maxValue) || 1
  return points.map((point, index) => ({
    x: tokenChartX(index, points.length, safeWidth),
    y:
      safeHeight -
      (Math.min(finiteNonNegative(point.totalTokens), safeMax) / safeMax) * safeHeight,
  }))
}

function monotoneTangents(points: ChartCoordinate[]) {
  if (points.length < 2) return points.map(() => 0)
  const slopes = points.slice(0, -1).map((point, index) => {
    const next = points[index + 1]
    const width = next.x - point.x
    return width === 0 ? 0 : (next.y - point.y) / width
  })
  const tangents = points.map((_, index) => {
    if (index === 0) return slopes[0]
    if (index === points.length - 1) return slopes[slopes.length - 1]
    const previous = slopes[index - 1]
    const next = slopes[index]
    if (previous === 0 || next === 0 || Math.sign(previous) !== Math.sign(next)) return 0
    return (previous + next) / 2
  })

  for (let index = 0; index < slopes.length; index += 1) {
    const slope = slopes[index]
    if (slope === 0) {
      tangents[index] = 0
      tangents[index + 1] = 0
      continue
    }
    const startRatio = tangents[index] / slope
    const endRatio = tangents[index + 1] / slope
    const magnitude = Math.hypot(startRatio, endRatio)
    if (magnitude <= 3) continue
    const scale = 3 / magnitude
    tangents[index] = scale * startRatio * slope
    tangents[index + 1] = scale * endRatio * slope
  }
  return tangents
}

function coordinate(value: number) {
  return value.toFixed(2)
}

export function smoothTokenLinePath(
  points: TokenChartValue[],
  width: number,
  height: number,
  maxValue: number,
) {
  const coordinates = chartCoordinates(points, width, height, maxValue)
  if (coordinates.length === 0) return ""
  const first = coordinates[0]
  if (coordinates.length === 1) {
    return `M ${coordinate(first.x)} ${coordinate(first.y)}`
  }

  const tangents = monotoneTangents(coordinates)
  const commands = [`M ${coordinate(first.x)} ${coordinate(first.y)}`]
  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const start = coordinates[index]
    const end = coordinates[index + 1]
    const segmentWidth = end.x - start.x
    const controlWidth = segmentWidth / 3
    commands.push(
      [
        "C",
        coordinate(start.x + controlWidth),
        coordinate(start.y + tangents[index] * controlWidth),
        coordinate(end.x - controlWidth),
        coordinate(end.y - tangents[index + 1] * controlWidth),
        coordinate(end.x),
        coordinate(end.y),
      ].join(" "),
    )
  }
  return commands.join(" ")
}

export function smoothTokenAreaPath(
  points: TokenChartValue[],
  width: number,
  height: number,
  maxValue: number,
) {
  const path = smoothTokenLinePath(points, width, height, maxValue)
  if (!path) return ""
  const safeWidth = finiteNonNegative(width)
  const safeHeight = finiteNonNegative(height)
  const firstX = points.length === 1 ? 0 : tokenChartX(0, points.length, safeWidth)
  const lastX = points.length === 1
    ? safeWidth
    : tokenChartX(points.length - 1, points.length, safeWidth)
  return `${path} L ${coordinate(lastX)} ${coordinate(safeHeight)} L ${coordinate(firstX)} ${coordinate(safeHeight)} Z`
}
