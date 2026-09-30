import {
  dshSearchErrorResponse,
  executeDshSearchMessages,
} from "@/lib/server/dsh-search/messages"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    return Response.json(
      await executeDshSearchMessages(await request.json(), request.signal),
      {
        headers: {
          "cache-control": "no-store",
        },
      },
    )
  } catch (error) {
    return dshSearchErrorResponse(error)
  }
}

export async function GET() {
  return Response.json({
    object: "dsh-search-messages-endpoint",
    provider: "switchgate",
    messagePath: "/api/dsh-search/messages",
    baseURL: "/api/dsh-search",
  })
}
