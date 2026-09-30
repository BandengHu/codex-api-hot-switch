import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

let pruneRequestLogDetails: typeof import("./request-log-details").pruneRequestLogDetails

// 明细根目录按调用时的环境变量解析，所以每个用例换一个 data 目录就能互相隔离。
let dataDir = ""
let detailsRoot = ""

async function useFreshDataDir() {
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
  dataDir = await mkdtemp(join(tmpdir(), "switchgate-detail-prune-"))
  detailsRoot = join(dataDir, "logs", "request-details")
  process.env.CODEX_HOT_SWITCH_DATA_DIR = dataDir
  await mkdir(detailsRoot, { recursive: true })
}

async function makeDetailDir(id: string, ageMs: number, now: number) {
  const dir = join(detailsRoot, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "raw-request.json"), "{}\n", "utf8")
  const stamp = new Date(now - ageMs)
  await utimes(dir, stamp, stamp)
}

async function listed() {
  return (await readdir(detailsRoot)).sort()
}

test.before(async () => {
  ;({ pruneRequestLogDetails } = await import("./request-log-details"))
})

test.beforeEach(useFreshDataDir)

test.after(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("保留集合内的明细目录不删，过期目录连同内容一起删掉", async () => {
  const now = Date.now()
  const keptId = `log-${now - 30 * DAY}-keep0001`
  const staleId = `log-${now - 30 * DAY}-stale001`
  await makeDetailDir(keptId, 30 * DAY, now)
  await makeDetailDir(staleId, 30 * DAY, now)

  const result = await pruneRequestLogDetails({
    keepIds: new Set([keptId]),
    now,
    graceMs: HOUR,
  })

  assert.equal(result.scanned, 2)
  assert.equal(result.removed, 1)
  assert.equal(result.kept, 1)
  assert.deepEqual(await listed(), [keptId])
})

test("宽限期内的在途目录先留着，避免删掉还没落盘的明细", async () => {
  const now = Date.now()
  const inflightId = `log-${now - 5 * 60 * 1000}-inflight`
  await makeDetailDir(inflightId, 5 * 60 * 1000, now)

  const result = await pruneRequestLogDetails({
    keepIds: new Set<string>(),
    now,
    graceMs: HOUR,
  })

  assert.equal(result.removed, 0)
  assert.equal(result.kept, 1)
  assert.deepEqual(await listed(), [inflightId])
})

test("目录名不带日志 id 时间戳时退回用 mtime 判断", async () => {
  const now = Date.now()
  await makeDetailDir("manual-drop", 30 * DAY, now)
  await makeDetailDir("manual-fresh", 0, now)

  const result = await pruneRequestLogDetails({
    keepIds: new Set<string>(),
    now,
    graceMs: HOUR,
  })

  assert.equal(result.removed, 1)
  assert.deepEqual(await listed(), ["manual-fresh"])
})

test("明细根目录不存在时直接返回空结果，不抛错", async () => {
  process.env.CODEX_HOT_SWITCH_DATA_DIR = join(dataDir, "never-created")
  const result = await pruneRequestLogDetails({ keepIds: new Set<string>() })
  assert.deepEqual(result, { scanned: 0, removed: 0, kept: 0 })
})
