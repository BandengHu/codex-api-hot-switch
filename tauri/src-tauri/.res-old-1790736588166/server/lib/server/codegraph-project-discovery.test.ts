import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { discoverCodegraphProjects } from "./codegraph-project-discovery"

async function withTempDirectory(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "switchgate-codegraph-"))
  try {
    await run(root)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
}

test("discovers the selected Git project and nested Git projects", async () => {
  await withTempDirectory(async (root) => {
    const nested = join(root, "packages", "nested")
    await mkdir(join(root, ".git"))
    await mkdir(join(nested, ".git"), { recursive: true })

    const result = await discoverCodegraphProjects(root)

    assert.deepEqual(result.projectRoots, [root, nested].sort((a, b) => a.localeCompare(b)))
    assert.deepEqual(result.indexedProjectRoots, [])
  })
})

test("recognizes Git worktrees and skips projects that already have an index", async () => {
  await withTempDirectory(async (root) => {
    const worktree = join(root, "worktree")
    const indexed = join(root, "indexed")
    await mkdir(worktree, { recursive: true })
    await writeFile(join(worktree, ".git"), "gitdir: C:/repo/.git/worktrees/worktree\n", "utf8")
    await mkdir(join(indexed, ".git"), { recursive: true })
    await mkdir(join(indexed, ".codegraph"))

    const result = await discoverCodegraphProjects(root)

    assert.deepEqual(result.projectRoots, [worktree])
    assert.deepEqual(result.indexedProjectRoots, [indexed])
  })
})

test("does not scan dependency, build, or reference directories", async () => {
  await withTempDirectory(async (root) => {
    for (const directory of ["node_modules", "dist-release", ".next", "_reference"]) {
      await mkdir(join(root, directory, "ignored", ".git"), { recursive: true })
    }
    const sourceProject = join(root, "apps", "source-project")
    await mkdir(join(sourceProject, ".git"), { recursive: true })

    const result = await discoverCodegraphProjects(root)

    assert.deepEqual(result.projectRoots, [sourceProject])
  })
})
