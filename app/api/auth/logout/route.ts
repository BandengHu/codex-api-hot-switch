import { clearSessionCookie, isSecureRequest } from "@/lib/server/account-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  return Response.json(
    { ok: true },
    {
      headers: {
        "set-cookie": clearSessionCookie({ secure: isSecureRequest(request) }),
        "cache-control": "no-store",
      },
    },
  )
}

