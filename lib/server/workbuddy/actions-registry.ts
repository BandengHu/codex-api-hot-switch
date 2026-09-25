import "server-only"

import type { WorkbuddyAccount } from "./account"
import {
 runAppearance,
 runAutomationCreate,
 runBuddyApp,
 runChat5Action,
 runCreateCanvas,
 runExpertBatch,
 runExpertLighthouse,
 runFirstBuddyAction,
 runLibraryRead,
 runModelChat,
 runPlaybookPrompt,
 runRichMeow,
 runSkillFresh,
 runTemplateUse,
} from "./actions-desktop"
import {
 runMiniExpert,
 runSchoolSeason,
 runSequentialAutomation,
 runSequentialChat,
 runSequentialChat5,
 runSequentialChat10,
 runSequentialModelChat,
 runSequentialPlaybook,
} from "./actions-mp"
import { inNightWindow, runNightChats } from "./chat"
import { reportChatActivity } from "./report"
import { findTask, findTaskWaiting } from "./task-query"

/**
 *可自动化任务动作表。
 *
 *照搬 `workbuddy2api-panel`（GitHub开源项目）实测口径，覆盖它已破解的全部任务
 * （17/18）；顺序即执行顺序：先解锁依赖项（first_buddy依赖活跃上报解锁，
 * chat_5与 first_buddy的执行都自带 report步骤）。
 *
 *所有动作幂等：已 claimed /已达标的任务由编排层直接跳过，不重复消耗上游配额。
 */

export interface TaskAction {
 taskCode: string
 /**展示用说明。 */
 desc: string
 /** true =尝试型（上游未证实可脚本化，跑了可能不点亮）。 */
 attempt?: boolean
 run: (account: WorkbuddyAccount) => Promise<string>
}

/**
 *夜猫子补足（black_cat）。
 *
 *上游口径是「23:00–08:00内**每天计 1 次**，累计 3 天」——同一天重复对话不再叠加。
 *所以这里**一次只补一次**：按差额连跑 N 次只会把配额烧在同一个计数位上（实测第二轮
 *两次对话后进度仍是 1/3）。补完回读，进度没动就说明今天这一格已经计过。
 */
async function runBlackCat(account: WorkbuddyAccount): Promise<string> {
 if (!inNightWindow()) {
 return "当前不在23:00–08:00计数窗口，行为不计分；等夜间再试"
 }
 const task = await findTask(account, "black_cat")
 if (!task) return "该账号没有这个任务"
 const target = task.target ||3
 const before = task.current
 if (before >= target) return "进度已达标，无需补足"

 const ok = await runNightChats(account,1, async (conversationId) => {
 await reportChatActivity(account, conversationId, "", "glm-5.2", "GLM-5.2")
 })
 if (!ok) return "夜间对话或上报失败，请稍后重试"

 const after = await findTaskWaiting(account, "black_cat").catch(() => undefined)
 const current = after?.current ?? before
 if (current <= before) {
 return `本次对话未让进度前移（仍为 ${current}/${target}）：该任务每天只计 1 次，需明天夜间再来；还差 ${target - current}天`
 }
 return `已完成本次夜间对话并上报（进度 ${current}/${target}）`
}

export const TASK_ACTIONS: TaskAction[] = [
 {
 taskCode: "chat_5",
 desc: "上报5条对话活跃事件（自动补足差额）",
 run: runChat5Action,
 },
 {
 taskCode: "first_buddy",
 desc: "上报解锁 →同意协议 →领取第一只 Buddy（+300分）",
 run: runFirstBuddyAction,
 },
 {
 taskCode: "Model_chat_GLM5.2",
 desc: "接受任务 → glm-5.2真实对话一次 →对齐模型上报",
 run: runModelChat,
 },
 {
 taskCode: "RichMeow_Chat",
 desc: "桌面指纹事件链上报（已验证：纯 API可点亮）",
 run: runRichMeow,
 },
 {
 taskCode: "Buddy_App",
 desc: "上报「进入 Buddy应用」事件链（已验证：纯 API可点亮）",
 run: runBuddyApp,
 },
 {
 taskCode: "Buddy_App_QQ",
 desc: "上报「进入企鹅教师助手」事件链（已验证：纯 API可点亮）",
 run: runBuddyApp,
 },
 {
 taskCode: "automation_1",
 desc: "上报「定时任务创建」事件（已验证：纯 API可点亮）",
 run: runAutomationCreate,
 },
 {
 taskCode: "Library_read",
 desc: "上报「读资料库介绍」事件（已验证：纯 API可点亮）",
 run: runLibraryRead,
 },
 {
 taskCode: "template_5",
 desc: "上报「使用模板创建任务」事件组 ×5（已验证：点亮）",
 run: runTemplateUse,
 },
 {
 taskCode: "playbook_prompt",
 desc: "上报「灵感案例做同款发送 Prompt」事件组（已验证：点亮）",
 run: runPlaybookPrompt,
 },
 {
 taskCode: "create_canvas",
 desc: "上报「设计创意画布创建」事件组（已验证：点亮，+300分）",
 run: runCreateCanvas,
 },
 {
 taskCode: "expert_5",
 desc: "真实专家召唤+使用链 ×5（专家市场列表+真实 chat）",
 run: (account) => runExpertBatch(account, "agent",5),
 },
 {
 taskCode: "Expert_team_use_3",
 desc: "真实专家团召唤+使用链 ×3",
 run: (account) => runExpertBatch(account, "team",3),
 },
 {
 taskCode: "Hp_Appearance",
 desc: "设置主题 API +皮肤生效事件",
 run: runAppearance,
 },
 {
 taskCode: "skill_1",
 desc: "真实对话 + skill_info技能加载事件",
 run: runSkillFresh,
 },
 {
 taskCode: "Expert_lighthouse",
 desc: "真实轻量云专家召唤+使用链（chat链带 has_expert）",
 run: runExpertLighthouse,
 },
 {
 taskCode: "black_cat",
 desc: "夜猫子：23:00–08:00窗口内 glm-5.2对话补足（窗口外提示稍后再试）",
 attempt: true,
 run: runBlackCat,
 },
 {
 taskCode: "school_season",
 desc: "校园日（小程序口径）：accept → mini对话+activityId上报 →领奖",
 run: runSchoolSeason,
 },
 {
 taskCode: "Sequential_Tasks_1",
 desc: "小程序首对话（小程序口径）：accept → mini对话上报 →领奖",
 run: runSequentialChat,
 },
 {
 taskCode: "Sequential_Tasks_2",
 desc: "小程序选专家对话（小程序口径）：市场专家 id → accept → expert_actual_use上报 →领奖",
 run: runMiniExpert,
 },
 {
 taskCode: "Sequential_Tasks_3",
 desc: "小程序五次对话（小程序口径）：accept → mini对话上报 ×5（自动补差额）→领奖",
 run: runSequentialChat5,
 },
 {
 taskCode: "Sequential_Tasks_4",
 desc: "小程序定时任务（预留，每日零点解锁一环）：accept →定时任务创建事件 →领奖",
 run: runSequentialAutomation,
 },
 {
 taskCode: "Sequential_Tasks_5",
 desc: "小程序使用 GLM5.2（预留）：accept →带模型字段的 mini对话上报 →领奖",
 run: runSequentialModelChat,
 },
 {
 taskCode: "Sequential_Tasks_6",
 desc: "小程序十次对话（预留）：accept → mini对话上报 ×target（自动补差额）→领奖",
 run: runSequentialChat10,
 },
 {
 taskCode: "Sequential_Tasks_7",
 desc: "体验灵感功能（预留，疑 PC口径）：accept →灵感事件组（PC+mp双形态）→领奖",
 run: runSequentialPlaybook,
 },
]

const ACTION_BY_CODE = new Map(TASK_ACTIONS.map((action) => [action.taskCode, action]))

/**查任务对应的动作；无则返回 undefined（不可自动化）。 */
export function findTaskAction(taskCode: string): TaskAction | undefined {
 return ACTION_BY_CODE.get(taskCode.trim())
}
