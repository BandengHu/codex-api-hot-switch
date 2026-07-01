import "server-only"

/**
 * Hosted web search relay.
 *
 * Codex (Responses API) exposes web search as a built-in/hosted tool type
 * (`web_search`, `web_search_preview`, ...). Chat-completions upstreams do not
 * understand those hosted tool types, so we "relay" them as a regular function
 * tool. When the upstream model calls that function, `codex-tool-proxy`
 * converts the call back into a Responses `web_search_call` event.
 *
 * The function tool name MUST stay in sync with the value stored in
 * `ToolContext.webSearchTools`, which is why both sides reference
 * `RELAY_WEB_SEARCH_TOOL_NAME`.
 */
export const RELAY_WEB_SEARCH_TOOL_NAME = "web_search"
export const EXA_WEB_SEARCH_URL = "https://mcp.exa.ai/mcp"
export const PARALLEL_WEB_SEARCH_URL = "https://search.parallel.ai/mcp"

const MAX_RESPONSE_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 25_000
const NO_RESULTS = "No search results found. Please try a different query."

const HOSTED_WEB_SEARCH_TOOL_TYPES = new Set([
  "web_search",
  "web_search_preview",
  "web_search_preview_2025_03_11",
])

export function isHostedWebSearchToolType(type: unknown): boolean {
  return typeof type === "string" && HOSTED_WEB_SEARCH_TOOL_TYPES.has(type.trim())
}

export function supportsRelayWebSearchProvider(
  provider: { protocol?: string; rawResponsesPassthrough?: boolean } | undefined,
) {
  if (!provider) return false
  return !(provider.protocol === "openai-responses" && provider.rawResponsesPassthrough === true)
}

export function relayWebSearchChatTool() {
  return {
    type: "function",
    function: {
      name: RELAY_WEB_SEARCH_TOOL_NAME,
      description:
        "Search the public web for up-to-date information. Use this when the answer may depend on recent events, current facts, or information not contained in the conversation.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description: "The search query to look up on the web.",
          },
        },
        required: ["query"],
      },
    },
  }
}

type AnyRecord = Record<string, any>

export type RelayWebSearchProvider = "exa" | "parallel"

export interface RelayWebSearchInput {
  query: string
  numResults?: number
  livecrawl?: "fallback" | "preferred"
  type?: "auto" | "fast" | "deep"
  contextMaxCharacters?: number
  sessionId?: string
  modelName?: string
}

export interface RelayWebSearchResult {
  provider: RelayWebSearchProvider
  query: string
  text: string
}

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function envProvider(): RelayWebSearchProvider | undefined {
  const value = (
    process.env.CODEX_WEB_SEARCH_PROVIDER ||
    process.env.SWITCHGATE_WEB_SEARCH_PROVIDER ||
    process.env.OPENCODE_WEBSEARCH_PROVIDER ||
    ""
  ).trim().toLowerCase()
  if (value === "exa" || value === "parallel") return value
  return undefined
}

function selectedProvider(): RelayWebSearchProvider {
  const override = envProvider()
  if (override) return override
  if (process.env.PARALLEL_API_KEY?.trim()) return "parallel"
  return "exa"
}

function exaUrl() {
  const apiKey = process.env.EXA_API_KEY?.trim()
  if (!apiKey) return EXA_WEB_SEARCH_URL
  const url = new URL(EXA_WEB_SEARCH_URL)
  url.searchParams.set("exaApiKey", apiKey)
  return url.toString()
}

function requestHeaders(provider: RelayWebSearchProvider) {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  }
  if (provider === "parallel") {
    headers["user-agent"] = "codex-switchgate/0.1"
    const apiKey = process.env.PARALLEL_API_KEY?.trim()
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
  }
  return headers
}

function mcpRequestBody(provider: RelayWebSearchProvider, input: RelayWebSearchInput) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params:
      provider === "parallel"
        ? {
            name: "web_search",
            arguments: {
              objective: input.query,
              search_queries: [input.query],
              ...(input.sessionId ? { session_id: input.sessionId } : {}),
              ...(input.modelName ? { model_name: input.modelName.slice(0, 100) } : {}),
            },
          }
        : {
            name: "web_search_exa",
            arguments: {
              query: input.query,
              type: input.type || "auto",
              numResults: input.numResults || 8,
              livecrawl: input.livecrawl || "fallback",
              ...(input.contextMaxCharacters
                ? { contextMaxCharacters: input.contextMaxCharacters }
                : {}),
            },
          },
  }
}

function parsePayload(payload: string) {
  const trimmed = payload.trim()
  if (!trimmed || !trimmed.startsWith("{")) return undefined
  const parsed = JSON.parse(trimmed)
  if (!isObject(parsed)) return undefined
  const content = parsed.result?.content
  if (!Array.isArray(content)) return undefined
  const item = content.find((entry) => isObject(entry) && typeof entry.text === "string")
  return typeof item?.text === "string" && item.text.trim() ? item.text : undefined
}

export function parseWebSearchMcpResponse(body: string) {
  const trimmed = body.trim()
  if (trimmed) {
    const direct = parsePayload(trimmed)
    if (direct) return direct
  }

  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue
    const data = line.slice("data: ".length)
    if (data.trim() === "[DONE]") continue
    const parsed = parsePayload(data)
    if (parsed) return parsed
  }
  return undefined
}

async function boundedText(response: Response) {
  if (!response.body) return await response.text()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error(`web_search response exceeded ${MAX_RESPONSE_BYTES} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(out)
}

function withTimeout(signal?: AbortSignal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  const abort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener("abort", abort, { once: true })
  }
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
    },
  }
}

export async function executeRelayWebSearch(
  input: RelayWebSearchInput,
  signal?: AbortSignal,
): Promise<RelayWebSearchResult> {
  const query = input.query.trim()
  if (!query) throw new Error("web_search 缺少 query")

  const provider = selectedProvider()
  const timeout = withTimeout(signal)
  try {
    const response = await fetch(provider === "parallel" ? PARALLEL_WEB_SEARCH_URL : exaUrl(), {
      method: "POST",
      headers: requestHeaders(provider),
      body: JSON.stringify(mcpRequestBody(provider, { ...input, query })),
      signal: timeout.signal,
    })
    const body = await boundedText(response)
    if (!response.ok) {
      throw new Error(`web_search ${provider} 返回 HTTP ${response.status}: ${body.slice(0, 500)}`)
    }
    return {
      provider,
      query,
      text: parseWebSearchMcpResponse(body) || NO_RESULTS,
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`web_search ${provider} 请求超时`)
    }
    throw error
  } finally {
    timeout.done()
  }
}
