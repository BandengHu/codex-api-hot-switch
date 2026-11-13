export interface WorkbuddyDynamicExpert {
  expertId: string
  expertName: string
}

interface WorkbuddyExpertTaskView {
  taskCode: string
  title: string
  jumpUrl: string
}

const FIXED_EXPERT_TASK_CODES = new Set([
  "WorkBuddy_Valorant",
  "workstation_expert",
  "expert_use_maidehao",
  "expert_use_douyinyin",
  "expert_use_shangjia_xuanchuan",
  "expert_use_bowangwang",
])

const EXPERT_ID_PATTERN = /^(?:ex_[A-Za-z0-9_-]+|WorkspaceBuilder)$/
const DYNAMIC_VALIDATION_TASK_CODE = "__dynamic_expert_validation__"

function queryValue(search: string, key: string) {
  return new URLSearchParams(search).get(key)?.trim() || ""
}

/**
 * 从上游任务深链提取临时专家 ID。
 *
 * 该模块供页面和服务端共用，不依赖 server-only；普通活动深链返回 undefined。
 */
export function resolveWorkbuddyDynamicExpertTask(
  task: WorkbuddyExpertTaskView,
): WorkbuddyDynamicExpert | undefined {
  if (FIXED_EXPERT_TASK_CODES.has(task.taskCode)) return undefined
  const jumpUrl = task.jumpUrl.trim()
  if (!jumpUrl) return undefined

  let parsed: URL
  try {
    parsed = new URL(jumpUrl)
  } catch {
    return undefined
  }

  const directId = queryValue(parsed.search, "expertId")
  const deeplink = queryValue(parsed.search, "deeplink")
  let nestedId = ""
  if (deeplink) {
    try {
      nestedId = queryValue(new URL(deeplink).search, "expertId")
    } catch {
      nestedId = ""
    }
  }
  const expertId = nestedId || directId
  if (!EXPERT_ID_PATTERN.test(expertId)) return undefined
  return {
    expertId,
    expertName: task.title.trim() || expertId,
  }
}

/** 校验单独传入的上游专家 ID；动态执行入口复用同一白名单。 */
export function isWorkbuddyDynamicExpertId(expertId: string) {
  return Boolean(
    resolveWorkbuddyDynamicExpertTask({
      taskCode: DYNAMIC_VALIDATION_TASK_CODE,
      title: "",
      jumpUrl: `workbuddy://chat?expertId=${encodeURIComponent(expertId)}`,
    }),
  )
}
