type AnyRecord = Record<string, any>

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function safeTrim(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

/**
 * 把 Responses 形态的 tool_choice 收成 chat 上游认的形态。
 *
 * WorkBuddy 上游（以及多数 OpenAI 兼容端点）只接受**字符串** tool_choice：
 * `auto` / `none` / `required` / 裸工具名；对象形态一律 HTTP 400。直连实测过：
 *
 *   "auto" / "none" / "required" / "exec_command"  → 200（后两者确实强制了调用）
 *   {type:"auto"} / {type:"none"} / {type:"function",function:{name}} → 400
 *
 * 所以这里把对象降级成裸工具名。名字不在本次出站的 tools 里就整个丢掉——那种请求本来
 * 就是无效的，留着只会让上游把整个请求拒掉。`auto`/`none`/`required` 已经在上一层
 * （`responsesToolChoiceToChat`）转成字符串了，这里再兜一次，保证不会漏出对象。
 *
 * 只用在 chat 出站这一层：native 协议那条路要用对象里的名字做工具名映射，不能走这个。
 */
export function chatWireToolChoice(
  choice: unknown,
  tools: AnyRecord[],
): string | undefined {
  if (typeof choice === "string") return choice
  if (!isObject(choice)) return undefined
  const type = safeTrim(choice.type)
  if (type === "auto" || type === "none" || type === "required") return type
  if (type !== "function") return undefined
  const name = safeTrim(choice.function?.name) || safeTrim(choice.name)
  if (!name) return undefined
  return tools.some((tool) => safeTrim(tool?.function?.name) === name) ? name : undefined
}
