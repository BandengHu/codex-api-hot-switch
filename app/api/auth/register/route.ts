import {
  hashPassword,
  passwordSalt,
} from "@/lib/server/account-auth"
import {
  createAccount,
  validatePassword,
  validateUsername,
  ACCOUNT_USERNAME_PATTERN,
} from "@/lib/server/accounts-store"
import { jsonError, readJsonBody } from "@/lib/server/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface RegisterBody {
  username?: unknown
  password?: unknown
}

/**
 * 自助注册：只建 pending 账号，必须由管理员审批后才能登录。
 * 账号目录与空白配置在审批通过时才创建，避免未审批账号占用磁盘。
 */
export async function POST(request: Request) {
  try {
    if (process.env.CODEX_HOT_SWITCH_REGISTRATION_CLOSED === "1") {
      return jsonError("管理员已关闭注册", 403)
    }
    const body = await readJsonBody<RegisterBody>(request)
    const username = validateUsername(body.username)
    validatePassword(body.password)
    if (!ACCOUNT_USERNAME_PATTERN.test(username)) {
      return jsonError("用户名格式不正确", 400)
    }

    const salt = passwordSalt()
    const account = await createAccount({
      username,
      passwordSalt: salt,
      passwordHash: hashPassword(body.password as string, salt),
      status: "pending",
      role: "member",
    })
    return Response.json(
      {
        ok: true,
        status: account.status,
        message: "注册成功，请等待管理员审批后登录",
      },
      { headers: { "cache-control": "no-store" } },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = message.includes("已被占用") ? 409 : 400
    return jsonError(message, status)
  }
}
