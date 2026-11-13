import { readAccountApiKey, readSessionCookie } from "@/lib/server/account-auth"
import { accessAuthRequired, accountFromRequest, withAccountContext } from "@/lib/server/access-guard"
import { jsonError } from "@/lib/server/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function hasSessionCookie(request: Request) {
  return readSessionCookie(request.headers.get("cookie"))
}

/**
 * 读取当前账号自己的 API Key，供设置页展示与复制。
 *
 * 只认网页登录会话，不接受用 API Key 换取自身明文——
 * 否则任何拿到 Key 的客户端都能把它当成“密钥读出接口”反复索取。
 */
export async function GET(request: Request) {
  if (!accessAuthRequired()) {
    return jsonError("本机模式没有服务器 API Key", 404)
  }
  const context = await accountFromRequest(request)
  if (!context) return jsonError("需要先登录", 401)
  if (context.account.status !== "active") {
    return jsonError("账号未启用", 403)
  }
  //必须来自网页会话，避免用 Key 反复索取明文。
  if (!(await hasSessionCookie(request))) {
    return jsonError("请先登录网页控制台再查看 API Key", 403)
  }

  const apiKey = await withAccountContext(context, () =>
    readAccountApiKey(context.dataDir),
  )
  if (!apiKey) {
    //历史账号只存过哈希，无法反推；让用户显式换一次即可拿到可回显的 Key。
    return Response.json(
      {
        ok: false,
        reason: "legacy-hash-only",
        message: "该账号的 Key 创建于旧版本，只能更换一次后才能在此查看。",
      },
      { status: 409, headers: { "cache-control": "no-store" } },
    )
  }
  return Response.json(
    { ok: true, apiKey },
    { headers: { "cache-control": "no-store" } },
  )
}
