import type { CodexSessionItem } from "@/lib/codex-session-types"

export interface CodexSessionProjectGroup {
  cwd: string
  label: string
  sessions: CodexSessionItem[]
  latestUpdatedAtMs: number
}

export function resolveProjectLabel(cwd: string) {
  const value = cwd.trim()
  if (!value) return "未知工作目录"
  const normalized = value.replace(/\\/g, "/").replace(/\/$/, "")
  const parts = normalized.split("/").filter(Boolean)
  return parts[parts.length - 1] || value
}

export function buildCodexSessionGroups(sessions: CodexSessionItem[]) {
  const buckets = new Map<string, CodexSessionItem[]>()
  for (const session of sessions) {
    const cwd = session.cwd.trim() || "未知工作目录"
    const bucket = buckets.get(cwd) || []
    bucket.push(session)
    buckets.set(cwd, bucket)
  }

  return Array.from(buckets.entries())
    .map(([cwd, groupSessions]) => ({
      cwd,
      label: resolveProjectLabel(cwd),
      sessions: [...groupSessions].sort(
        (left, right) =>
          right.updatedAtMs - left.updatedAtMs ||
          left.title.localeCompare(right.title, "zh-CN") ||
          left.id.localeCompare(right.id),
      ),
      latestUpdatedAtMs: Math.max(...groupSessions.map((session) => session.updatedAtMs), 0),
    }))
    .sort(
      (left, right) =>
        right.latestUpdatedAtMs - left.latestUpdatedAtMs ||
        left.cwd.localeCompare(right.cwd, "zh-CN"),
    )
}

export function filterCodexSessionGroups(
  groups: CodexSessionProjectGroup[],
  query: string,
) {
  const keyword = query.trim().toLowerCase()
  if (!keyword) return groups

  return groups
    .map((group) => {
      const groupMatches = [group.cwd, group.label].join("\n").toLowerCase().includes(keyword)
      if (groupMatches) return group

      const sessions = group.sessions.filter((session) =>
        [
          session.id,
          session.title,
          session.cwd,
          session.modelProvider,
          session.model,
          session.reasoningEffort,
        ]
          .join("\n")
          .toLowerCase()
          .includes(keyword),
      )
      return sessions.length > 0 ? { ...group, sessions } : null
    })
    .filter((group): group is CodexSessionProjectGroup => Boolean(group))
}
