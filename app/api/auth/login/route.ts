import {
  isSecureRequest,
  issueSessionCookie,
  verifyPassword,
} from "@/lib/server/account-auth"
import {
  findAccountByUsername,
  normalizeUsername,
} from "@/lib/server/accounts-store"
import { jsonError, readJsonBody } from "@/lib/server/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface LoginBody {
  username?: unknown
  password?: unknown
}

/**
 * 账号密码登录。待审批账号与已停用账号都返回 403，
 * 但提示语区分开，方便用户知道该等审批还是该联系管理员。
 */
export async function POST(request: Request) {
  try {
    const body = await readJsonBody<LoginBody>(request)
    const username = normalizeUsername(body.username)
    const password = typeof body.password === "string" ? body.password : ""
    if (!username || !password) return jsonError("请输入用户名和密码", 400)

    const account = await findAccountByUsername(username)
    // 账号不存在与密码错误返回同一条提示，避免被用来枚举用户名。
    if (!account || !verifyPassword(password, account.passwordSalt, account.passwordHash)) {
      return jsonError("用户名或密码错误", 401)
    }
    if (account.status === "pending") {
      return jsonError("账号正在等待管理员审批", 403)
    }
    if (account.status !== "active") {
      return jsonError("账号已被停用，请联系管理员", 403)
    }

    const session = await issueSessionCookie(account.id, {
      secure: isSecureRequest(request),
    })
    return Response.json(
      {
        ok: true,
        expiresAt: session.expiresAt,
        account: {
          id: account.id,
          username: account.username,
          role: account.role,
        },
      },
      {
        headers: {
          "set-cookie": session.cookie,
          "cache-control": "no-store",
        },
      },
    )
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 400)
  }
}
