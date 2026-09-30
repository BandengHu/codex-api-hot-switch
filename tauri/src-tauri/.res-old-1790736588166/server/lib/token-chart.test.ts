import assert from "node:assert/strict"
import test from "node:test"
import {
  smoothTokenAreaPath,
  smoothTokenLinePath,
  tokenChartX,
} from "./token-chart"

test("smooth token line is empty for no points and stable for one point", () => {
  assert.equal(smoothTokenLinePath([], 720, 250, 100), "")
  assert.equal(smoothTokenLinePath([{ totalTokens: 50 }], 720, 250, 100), "M 360.00 125.00")
  assert.equal(tokenChartX(0, 1, 720), 360)
})

test("smooth token line uses monotone cubic segments without invalid coordinates", () => {
  const path = smoothTokenLinePath(
    [
      { totalTokens: 0 },
      { totalTokens: 100 },
      { totalTokens: 20 },
      { totalTokens: 80 },
      { totalTokens: 0 },
    ],
    720,
    250,
    100,
  )
  assert.match(path, /^M 0\.00 250\.00 C /)
  assert.equal((path.match(/ C /g) || []).length, 4)
  assert.doesNotMatch(path, /NaN|Infinity/)

  const yCoordinates = [...path.matchAll(/(?:M|C)\s+(?:\d+\.\d+\s+)*?(-?\d+\.\d+)(?=\s+(?:C|$))/g)]
  assert.ok(yCoordinates.length >= 1)
})

test("smooth token area reuses the line and closes on the baseline", () => {
  const points = [{ totalTokens: 10 }, { totalTokens: 20 }, { totalTokens: 5 }]
  const line = smoothTokenLinePath(points, 300, 100, 20)
  const area = smoothTokenAreaPath(points, 300, 100, 20)
  assert.ok(area.startsWith(line))
  assert.ok(area.endsWith("L 300.00 100.00 L 0.00 100.00 Z"))
  assert.doesNotMatch(area, /NaN|Infinity/)
})
