import { clearSessionCookie } from "@/lib/server/access-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST() {
  return Response.json(
    { ok: true },
    {
      headers: {
        "set-cookie": clearSessionCookie(),
        "cache-control": "no-store",
      },
    },
  )
}

