import "server-only"

import { accountDataDirPath, findAccountById, type AccountRecord } from "./accounts-store"
import { readSessionCookie, verifyAccountApiKey } from "./account-auth"
import { runWithAccountDataDir } from "./data-root"

/**
 * 服务器部署（systemd 设置 CODEX_HOT_SWITCH_SERVER_UI=1）才强制鉴权与账号隔离。
 * 本机桌面/壳模式保持原来的免登录、单数据目录体验。
 */
export function accessAuthRequired() {
  return process.env.CODEX_HOT_SWITCH_SERVER_UI === "1"
}

function bearerToken(header: string | null) {
  if (!header) return ""
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() || ""
}

export function apiKeyFromHeaders(headers: Pick<Headers, "get">) {
  return (
    headers.get("x-api-key")?.trim() ||
    bearerToken(headers.get("authorization"))
  )
}

export interface AccessContext {
  account: AccountRecord
  dataDir: string
}

async function activeAccount(id: string) {
  const account = await findAccountById(id)
  return account && account.status === "active" ? account : null
}

/** 仅用 API Key 解析账号；Cookie 不参与，避免网页登录被当成 API 凭证。 */
export async function accountFromApiKey(
  headers: Pick<Headers, "get">,
): Promise<AccessContext | null> {
  const apiKey = apiKeyFromHeaders(headers)
  if (!apiKey) return null
  const account = await accountFromActiveApiKey(apiKey)
  return account ? { account, dataDir: accountDataDirPath(account.id) } : null
}

async function accountFromActiveApiKey(apiKey: string) {
  // 账号数量很少，逐个比对即可；比对是常数时间，不泄露命中位置。
  const { listAccounts } = await import("./accounts-store")
  for (const candidate of await listAccounts()) {
    if (candidate.status !== "active") continue
    if (await verifyAccountApiKey(accountDataDirPath(candidate.id), apiKey)) {
      return candidate
    }
  }
  return null
}

/** 网页会话：Cookie 或 API Key 任一通过；用于控制台与设置页。 */
export async function accountFromRequest(request: Request): Promise<AccessContext | null> {
  const session = await readSessionCookie(request.headers.get("cookie"))
  if (session) {
    const account = await activeAccount(session.accountId)
    if (account) return { account, dataDir: accountDataDirPath(account.id) }
  }
  return accountFromApiKey(request.headers)
}

/**
 * 把一次请求绑定到它所属账号的数据目录。
 * 后续所有配置、日志与号池读写都通过 AsyncLocalStorage 解析到这个目录。
 */
export function withAccountContext<T>(context: AccessContext, fn: () => T): T {
  return runWithAccountDataDir(context.dataDir, fn)
}

export async function isApiKeyAuthorizedHeaders(headers: Pick<Headers, "get">) {
  if (!accessAuthRequired()) return true
  return Boolean(await accountFromApiKey(headers))
}

/**
 * API 调用只接受 API Key，不接受网页登录 Cookie。
 * 这样网页登录只用于控制台/设置，不会改变 Codex 客户端和 MCP 的调用方式。
 */
export async function isApiKeyAuthorized(request: Request): Promise<boolean> {
  return isApiKeyAuthorizedHeaders(request.headers)
}

/** 控制台/设置接口：API Key 或网页登录 Cookie 任一通过即可。 */
export async function isAuthorized(request: Request): Promise<boolean> {
  if (!accessAuthRequired()) return true
  return Boolean(await accountFromRequest(request))
}

/**
 * 路由统一入口：校验通过后，把后续逻辑放进该账号的数据目录上下文执行。
 *
 * 返回 null 表示需要鉴权但未通过，调用方直接回 401。
 * 本机模式不做鉴权，也不建立账号上下文（沿用共享数据目录）。
 */
export async function runAuthorized<T>(
  request: Request,
  handler: (context: AccessContext) => Promise<T>,
): Promise<T | null> {
  if (!accessAuthRequired()) {
    return handler({ account: null as never, dataDir: "" })
  }
  const context = await accountFromRequest(request)
  if (!context) return null
  return withAccountContext(context, () => handler(context))
}

export function apiKeyRequiredResponse() {
  return Response.json(
    {
      error: {
        message: "需要有效的 SwitchGate API Key",
        type: "authentication_error",
      },
    },
    {
      status: 401,
      headers: {
        "www-authenticate": 'Bearer realm="switchgate"',
        "cache-control": "no-store",
      },
    },
  )
}

export function authRequiredResponse() {
  return Response.json(
    {
      error: {
        message: "需要有效的 SwitchGate API Key 或网页登录会话",
        type: "authentication_error",
      },
    },
    {
      status: 401,
      headers: {
        "www-authenticate": 'Bearer realm="switchgate"',
        "cache-control": "no-store",
      },
    },
  )
}
