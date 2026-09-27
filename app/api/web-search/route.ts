import { NextResponse } from "next/server"
import { browseWebPages, searchWeb } from "@/lib/server/web"
import { WebSearchError } from "@/lib/server/web/errors"
import { errorMessage, readJsonBody } from "@/lib/server/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type AnyRecord = Record<string, unknown>

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function errorResponse(error: unknown) {
  const status =
    error instanceof WebSearchError && error.code === "WEB_INVALID_REQUEST"
      ? 400
      : 502
  const payload =
    error instanceof WebSearchError
      ? error.toJSON()
      : {
          code: "WEB_INTERNAL_ERROR",
          message: errorMessage(error),
          retryable: true,
          provider: "switchgate",
        }
  return NextResponse.json(
    { error: payload },
    { status, headers: { "cache-control": "no-store" } },
  )
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<unknown>(request)
    if (!isObject(body)) {
      throw new WebSearchError("Web API 请求体必须是 JSON 对象", {
        code: "WEB_INVALID_REQUEST",
        retryable: false,
        provider: "switchgate",
      })
    }
    const operation = typeof body.operation === "string" ? body.operation : "search"
    if (operation === "search") {
      const queries = Array.isArray(body.queries)
        ? body.queries
        : [
            {
              query: body.query ?? body.q ?? body.search_query ?? body.input,
              recencyDays: body.recencyDays,
              domains: body.domains,
              language: body.language,
            },
          ]
      const rawLimit = body.limit ?? body.numResults
      const parsedLimit =
        typeof rawLimit === "number"
          ? rawLimit
          : typeof rawLimit === "string" && rawLimit.trim()
            ? Number(rawLimit)
            : undefined
      return NextResponse.json(
        await searchWeb(
          {
            queries: queries as any,
            limit: typeof parsedLimit === "number" && Number.isFinite(parsedLimit)
              ? parsedLimit
              : 8,
            ...(body.answer === true ? { answer: true } : {}),
            ...(body.includeContent === true ? { includeContent: true } : {}),
          },
          request.signal,
        ),
        { headers: { "cache-control": "no-store" } },
      )
    }
    if (operation === "browse") {
      return NextResponse.json(await browseWebPages(body, request.signal), {
        headers: { "cache-control": "no-store" },
      })
    }
    throw new WebSearchError(`不支持的 Web API 操作：${operation}`, {
      code: "WEB_INVALID_OPERATION",
      retryable: false,
      provider: "switchgate",
    })
  } catch (error) {
    return errorResponse(error)
  }
}
