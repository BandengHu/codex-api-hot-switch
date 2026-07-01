import "server-only"

import type { ReasoningEffort } from "@/lib/types"
import { joinUrl, providerHeaders, type ProxyTarget } from "./common"
import {
  buildNativeCanonicalRequest,
  nativeAdapter,
  type CanonicalContentPart,
  type CanonicalInputItem,
  type CanonicalResponseFormat,
  type NativeAdapter,
  type NativeCanonicalRequest,
} from "./native-canonical"
import {
  buildOpenAIChatFromNativeResponse,
  buildOpenAIResponseFromNative,
  openAIUsageFromGemini,
  type NativeOutputItem,
} from "./native-openai"
import {
  geminiClientToolCallId,
  geminiUpstreamToolCallId,
} from "./gemini-tool-ids"
import { geminiFunctionDeclaration } from "./gemini-schema"
import { rectifyGeminiToolCallArgs } from "./gemini-tool-args"

type AnyRecord = Record<string, any>

export interface GeminiBuiltRequest {
  url: string
  init: RequestInit
  rewrittenBody: unknown
  adapter: NativeAdapter
}

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function thinkingBudget(reasoning: ReasoningEffort) {
  if (reasoning === "minimal") return 512
  if (reasoning === "low") return 1024
  if (reasoning === "medium") return 4096
  if (reasoning === "high") return 8192
  if (reasoning === "xhigh" || reasoning === "max") return 16384
  if (reasoning === "auto") return -1
  return 0
}

function normalizeGeminiModelId(modelId: string) {
  return modelId.trim().replace(/^\/+/, "").replace(/^models\//i, "")
}

function normalizeGeminiBaseUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/#+$/, "").replace(/\/+$/, "")
  return trimmed
    .replace(/\/models$/i, "")
    .replace(/\/v1beta\/openai(?:\/(?:chat\/completions|responses))?$/i, "/v1beta")
    .replace(/\/v1\/openai(?:\/(?:chat\/completions|responses))?$/i, "/v1")
}

function geminiUrl(target: ProxyTarget, stream: boolean) {
  const method = stream ? "streamGenerateContent" : "generateContent"
  const url = new URL(
    joinUrl(
      normalizeGeminiBaseUrl(target.provider.baseUrl),
      `models/${normalizeGeminiModelId(target.modelId)}:${method}`,
    ),
  )
  if (stream) {
    url.searchParams.set("alt", "sse")
  }
  if (target.provider.apiKey.trim()) {
    url.searchParams.set("key", target.provider.apiKey.trim())
  }
  return url.toString()
}

function dataUrlParts(url: string) {
  const match = url.match(/^data:([^;,]+);base64,([\s\S]+)$/)
  if (!match) return null
  return { mimeType: match[1], data: match[2] }
}

function contentPartToGemini(part: CanonicalContentPart) {
  if (part.type === "text") return { text: part.text }
  if (part.type === "image") {
    const dataUrl = dataUrlParts(part.url)
    if (!dataUrl) {
      return { fileData: { fileUri: part.url } }
    }
    return {
      inlineData: {
        mimeType: dataUrl.mimeType,
        data: dataUrl.data,
      },
    }
  }
  const dataUrl = dataUrlParts(part.fileData)
  if (!dataUrl) {
    throw new Error(
      `Gemini 原生协议只支持 data URL 文件输入${part.filename ? `：${part.filename}` : ""}`,
    )
  }
  return {
    inlineData: {
      mimeType: dataUrl.mimeType,
      data: dataUrl.data,
    },
  }
}

function responseObject(output: string) {
  try {
    const parsed = JSON.parse(output)
    return isObject(parsed) ? parsed : { output: parsed }
  } catch {
    return { output }
  }
}

function geminiThoughtSignature(part: AnyRecord) {
  const value = part.thoughtSignature ?? part.thought_signature
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function flushContent(contents: AnyRecord[], role: "user" | "model", parts: AnyRecord[]) {
  if (parts.length === 0) return
  const last = contents.at(-1)
  if (last?.role === role && Array.isArray(last.parts)) {
    last.parts.push(...parts)
  } else {
    contents.push({ role, parts })
  }
}

function canonicalInputToGeminiContents(input: CanonicalInputItem[]) {
  const contents: AnyRecord[] = []
  const callNameById = new Map(
    input
      .filter((item) => item.type === "function_call")
      .map((item) => [item.callId, item.name]),
  )
  let currentRole: "user" | "model" | null = null
  let currentParts: AnyRecord[] = []

  const flush = () => {
    if (!currentRole) return
    flushContent(contents, currentRole, currentParts)
    currentRole = null
    currentParts = []
  }

  for (const item of input) {
    if (item.type === "message") {
      const role = item.role === "assistant" ? "model" : "user"
      if (currentRole !== role) flush()
      currentRole = role
      currentParts.push(...item.content.map(contentPartToGemini))
      continue
    }
    if (item.type === "thinking") {
      continue
    }
    if (item.type === "function_call") {
      if (currentRole !== "model") flush()
      currentRole = "model"
      const id = geminiUpstreamToolCallId(item.callId)
      const part: AnyRecord = {
        functionCall: {
          name: item.name,
          args: item.argumentsObject,
          ...(id ? { id } : {}),
        },
      }
      if (item.geminiThoughtSignature) {
        part.thoughtSignature = item.geminiThoughtSignature
      }
      currentParts.push(part)
      continue
    }
    if (currentRole !== "user") flush()
    currentRole = "user"
    const id = geminiUpstreamToolCallId(item.callId)
    const name = callNameById.get(item.callId)
    if (!name) {
      throw new Error(
        `Unable to resolve Gemini functionResponse.name for call_id \`${item.callId}\``,
      )
    }
    currentParts.push({
      functionResponse: {
        name,
        response: responseObject(item.output),
        ...(id ? { id } : {}),
      },
    })
  }

  flush()
  return contents.length > 0
    ? contents
    : [{ role: "user", parts: [{ text: "" }] }]
}

function geminiFunctionCallingConfig(canonical: NativeCanonicalRequest) {
  const choice = canonical.toolChoice
  if (!choice) return undefined
  if (choice.type === "none") return { mode: "NONE" }
  if (choice.type === "auto") return { mode: "AUTO" }
  if (choice.type === "any") return { mode: "ANY" }
  return {
    mode: "ANY",
    allowedFunctionNames: [choice.name],
  }
}

function buildGeminiBody(canonical: NativeCanonicalRequest) {
  const generationConfig: AnyRecord = {}
  const budget = thinkingBudget(canonical.reasoning)
  if (budget !== 0) {
    generationConfig.thinkingConfig =
      budget === -1 ? { includeThoughts: false } : { thinkingBudget: budget }
  }
  if (canonical.maxOutputTokens) {
    generationConfig.maxOutputTokens = canonical.maxOutputTokens
  }
  if (canonical.temperature != null) generationConfig.temperature = canonical.temperature
  if (canonical.topP != null) generationConfig.topP = canonical.topP
  if (canonical.topK != null) generationConfig.topK = canonical.topK
  if (canonical.frequencyPenalty != null) generationConfig.frequencyPenalty = canonical.frequencyPenalty
  if (canonical.presencePenalty != null) generationConfig.presencePenalty = canonical.presencePenalty
  if (canonical.seed != null) generationConfig.seed = canonical.seed
  if (canonical.candidateCount != null) generationConfig.candidateCount = canonical.candidateCount
  if (canonical.stopSequences.length > 0) {
    generationConfig.stopSequences = canonical.stopSequences
  }
  applyGeminiResponseFormat(generationConfig, canonical.responseFormat)

  const body: AnyRecord = {
    contents: canonicalInputToGeminiContents(canonical.input),
  }

  if (canonical.instructions) {
    body.systemInstruction = { parts: [{ text: canonical.instructions }] }
  }
  if (canonical.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: canonical.tools.map((tool) =>
          geminiFunctionDeclaration({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          }),
        ),
      },
    ]
  }
  const functionCallingConfig = geminiFunctionCallingConfig(canonical)
  if (functionCallingConfig) {
    body.toolConfig = { functionCallingConfig }
  }
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig
  }

  return body
}

function applyGeminiResponseFormat(
  generationConfig: AnyRecord,
  format: CanonicalResponseFormat | undefined,
) {
  if (!format) return
  generationConfig.responseMimeType = "application/json"
  if (format.type === "json_schema") {
    generationConfig.responseJsonSchema = format.schema
  }
}

export function buildGeminiRequest(
  target: ProxyTarget,
  path: string,
  body: unknown,
): GeminiBuiltRequest {
  const canonical = buildNativeCanonicalRequest(target, path, body)
  const rewrittenBody = buildGeminiBody(canonical)

  return {
    url: geminiUrl(target, canonical.requestIsStream),
    rewrittenBody,
    adapter: nativeAdapter("gemini", canonical),
    init: {
      method: "POST",
      headers: providerHeaders(target.provider, {
        accept: canonical.requestIsStream ? "text/event-stream" : "application/json",
        "content-type": "application/json",
      }),
      body: JSON.stringify(rewrittenBody),
    },
  }
}

function argumentsTextFromObject(value: unknown) {
  if (value == null) return "{}"
  return JSON.stringify(value)
}

function firstCandidate(payload: unknown) {
  if (!isObject(payload) || !Array.isArray(payload.candidates)) return null
  const candidate = payload.candidates[0]
  return isObject(candidate) ? candidate : null
}

function geminiBlockReason(payload: unknown) {
  if (!isObject(payload)) return ""
  const reason = payload.promptFeedback?.blockReason
  return typeof reason === "string" ? reason.trim() : ""
}

function geminiStatus(candidate: AnyRecord | null, blockReason = "") {
  if (blockReason) return "completed"
  const finishReason = String(candidate?.finishReason || "").toUpperCase()
  return finishReason === "MAX_TOKENS" ? "incomplete" : "completed"
}

function outputItemsFromGemini(
  payload: unknown,
  adapter?: Partial<Pick<NativeAdapter, "geminiToolSchemaHints">>,
): NativeOutputItem[] {
  const blockReason = geminiBlockReason(payload)
  if (blockReason) {
    return [{
      type: "text",
      text: `Request blocked by Gemini safety filters: ${blockReason}`,
    }]
  }
  const candidate = firstCandidate(payload)
  const parts = candidate?.content?.parts
  if (!Array.isArray(parts)) return []
  const output: NativeOutputItem[] = []
  for (const part of parts) {
    if (!isObject(part)) continue
    if (typeof part.text === "string") {
      output.push(
        part.thought === true || isObject(part.thought)
          ? { type: "reasoning", text: part.text }
          : { type: "text", text: part.text },
      )
    } else if (isObject(part.thought) && typeof part.thought.text === "string") {
      output.push({ type: "reasoning", text: part.thought.text })
    } else if (isObject(part.functionCall)) {
      const callId = geminiClientToolCallId(part.functionCall.id)
      const name = String(part.functionCall.name || "")
      const args = rectifyGeminiToolCallArgs(
        name,
        part.functionCall.args,
        adapter?.geminiToolSchemaHints,
      )
      output.push({
        type: "function_call",
        id: callId,
        callId,
        name,
        argumentsText: argumentsTextFromObject(args),
        geminiThoughtSignature: geminiThoughtSignature(part),
      })
    }
  }
  return output
}

export function toOpenAIResponseFromGemini(
  payload: unknown,
  model: string,
  adapter?: Partial<Pick<NativeAdapter, "reverseToolNameMap" | "toolContext" | "geminiToolSchemaHints">>,
) {
  const candidate = firstCandidate(payload)
  const blockReason = geminiBlockReason(payload)
  const status = geminiStatus(candidate, blockReason)
  return buildOpenAIResponseFromNative({
    model,
    output: outputItemsFromGemini(payload, adapter),
    usage: openAIUsageFromGemini(
      isObject(payload) ? payload.usageMetadata || payload.usage : undefined,
    ),
    status,
    incompleteReason: status === "incomplete" ? "max_output_tokens" : undefined,
    reverseToolNameMap: adapter?.reverseToolNameMap,
    toolContext: adapter?.toolContext,
  })
}

export function toOpenAIChatFromGemini(
  payload: unknown,
  model: string,
  requestedModel = model,
  reverseToolNameMap: Record<string, string> = {},
  toolContext?: NativeAdapter["toolContext"],
) {
  return buildOpenAIChatFromNativeResponse(
    toOpenAIResponseFromGemini(payload, model, { reverseToolNameMap, toolContext }),
    requestedModel,
    reverseToolNameMap,
  )
}
