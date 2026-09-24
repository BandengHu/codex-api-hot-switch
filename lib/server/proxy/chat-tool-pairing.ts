type AnyRecord = Record<string, any>

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function toolCallIds(message: AnyRecord): string[] {
  if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) return []
  const ids: string[] = []
  for (const call of message.tool_calls) {
    const id = isObject(call) && typeof call.id === "string" ? call.id.trim() : ""
    if (id) ids.push(id)
  }
  return ids
}

function toolResultId(message: AnyRecord): string {
  if (message.role !== "tool") return ""
  return typeof message.tool_call_id === "string" ? message.tool_call_id.trim() : ""
}

/**
 * 把插在同一批 tool_call 结果之间的非 tool 消息挪到整组之后。
 *
 * OpenAI 兼容协议要求 `assistant.tool_calls` 后面紧跟它每个调用的 `role:tool` 结果，
 * 结果之间插任何消息都算配对断裂，上游会判 `tool_call_sequence_broken`（11148）并顶死
 * 整条会话。Codex 侧就有这种插入行为（例如把 `<image_resize_notice>` 当独立消息放在
 * 工具输出之间），并行调用时它正好落在两份结果中间。
 *
 * 只调顺序、不改内容：
 *
 *     assistant[c00 c01] | tool c00 | X | tool c01
 *   → assistant[c00 c01] | tool c00 | tool c01 | X
 *
 * 结果的相对顺序保持原样，不引入新的顺序敏感问题。没有插入物时原样返回同一个数组。
 */
export function repackToolResultBlocks(messages: AnyRecord[]): AnyRecord[] {
  if (messages.length < 3) return messages
  const out: AnyRecord[] = []
  let changed = false
  let index = 0
  while (index < messages.length) {
    const message = messages[index]
    const wanted = isObject(message) ? toolCallIds(message) : []
    if (wanted.length === 0) {
      out.push(message)
      index += 1
      continue
    }
    const batch = new Set(wanted)
    out.push(message)
    index += 1

    const results: AnyRecord[] = []
    const between: AnyRecord[] = []
    let sawIntruder = false
    while (index < messages.length) {
      const candidate = messages[index]
      if (!isObject(candidate)) break
      if (candidate.role === "tool") {
        if (!batch.has(toolResultId(candidate))) break
        results.push(candidate)
        if (sawIntruder) changed = true
        index += 1
        continue
      }
      // 这组还没有任何结果：交给 cleanupOrphanToolCalls 处理悬空调用。
      if (results.length === 0) break
      // 下一组 assistant.tool_calls 是新组头，绝不能当成插入物吞掉，否则它自己那批
      // 结果永远得不到重排。
      if (candidate.role === "assistant" && toolCallIds(candidate).length > 0) break
      between.push(candidate)
      sawIntruder = true
      index += 1
    }
    out.push(...results, ...between)
  }
  return changed ? out : messages
}

/**
 * 剔除无法配对的 tool_call 与 tool 结果。
 *
 * 带 `tool_calls` 的 assistant 消息，其每个调用都要有对应的 `role:tool` 结果；反之
 * `role:tool` 也要有对应的前置调用。缺任一侧，上游会以 HTTP 400 拒绝整个请求——而且
 * 这条坏历史会被每次请求原样重放，等于整条会话报废（工具超时、用户中断、参数非法都
 * 会留下这种半截配对）。
 *
 * 两侧共用同一份 `keepCalls` 按 id 对称裁剪，任何输入都不会再产生半截配对：
 *   - assistant.tool_calls 只保留有结果的调用，删空了就把整个消息去掉（只留一条空
 *     assistant 消息没有意义，部分上游还会拒空 content）；
 *   - role:tool 只保留其调用仍在的消息，孤儿结果整条删除。
 *
 * 没有任何工具流量时原样返回同一个数组。
 */
export function cleanupOrphanToolCalls(messages: AnyRecord[]): AnyRecord[] {
  if (messages.length === 0) return messages

  const callIds = new Set<string>()
  const resultIds = new Set<string>()
  for (const message of messages) {
    if (!isObject(message)) continue
    for (const id of toolCallIds(message)) callIds.add(id)
    const resultId = toolResultId(message)
    if (resultId) resultIds.add(resultId)
  }
  if (callIds.size === 0 && resultIds.size === 0) return messages

  const keepCalls = new Set<string>()
  for (const id of callIds) {
    if (resultIds.has(id)) keepCalls.add(id)
  }

  const kept: AnyRecord[] = []
  let changed = false
  for (const message of messages) {
    if (!isObject(message)) {
      kept.push(message)
      continue
    }
    if (message.role === "tool") {
      if (!keepCalls.has(toolResultId(message))) {
        changed = true
        continue
      }
      kept.push(message)
      continue
    }
    const ids = toolCallIds(message)
    if (ids.length === 0) {
      kept.push(message)
      continue
    }
    const surviving = ids.filter((id) => keepCalls.has(id))
    if (surviving.length === ids.length) {
      kept.push(message)
      continue
    }
    changed = true
    if (surviving.length === 0) {
      const hasContent = typeof message.content === "string" && message.content.trim().length > 0
      if (hasContent) {
        const { tool_calls: _dropped, ...withoutCalls } = message
        kept.push(withoutCalls)
      }
      continue
    }
    const survivingSet = new Set(surviving)
    kept.push({
      ...message,
      tool_calls: message.tool_calls.filter(
        (call: unknown) =>
          isObject(call) && typeof call.id === "string" && survivingSet.has(call.id.trim()),
      ),
    })
  }
  return changed ? kept : messages
}

/**
 * 出站前的工具配对收口：先把结果重排到一起，再删掉无法配对的条目。
 *
 * 顺序不能反：repack 只挪顺序，清理要看到「同批结果已连续」之后才能按 id 判断配对；
 * 两侧同口径裁剪后，发出的请求不会再出现半截配对。
 */
export function normalizeChatToolPairing(messages: AnyRecord[]): AnyRecord[] {
  return cleanupOrphanToolCalls(repackToolResultBlocks(messages))
}
