import "server-only"

import { createHash } from "node:crypto"

import { accountDataDirPath, findAccountById, type AccountRecord } from "./accounts-store"
import { readSessionCookie, verifyAccountApiKey } from "./account-auth"
import { verifyTempKey } from "./temp-keys"
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

/**
 * 鉴权失败时必须留下可诊断的痕迹，否则前端只看到 401，
 * 服务端日志却一片空白，只能靠猜是 key 错、请求头错还是路径错。
 *
 * 只记录 SHA-256 前 8 位指纹与长度：足以判断「是不是同一把 key」，
 * 但无法还原密钥，即使日志泄露也没有利用价值。
 */
function describeApiKey(apiKey: string) {
  if (!apiKey) return "absent"
  const fp = createHash("sha256").update(apiKey).digest("hex").slice(0, 8)
  return `fp=${fp} len=${apiKey.length}`
}

function logAuthFailure(headers: Pick<Headers, "get">, reason: string) {
  const via = headers.get("x-api-key")
    ? "x-api-key"
    : headers.get("authorization")
      ? "authorization"
      : "none"
  const apiKey = apiKeyFromHeaders(headers)
  const origin = headers.get("origin") || "-"
  console.warn(
    `[switchgate] auth rejected reason=${reason} via=${via} key=${describeApiKey(apiKey)} origin=${origin}`,
  )
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
  if (!apiKey) {
    logAuthFailure(headers, "no-key")
    return null
  }
  const account = await accountFromActiveApiKey(apiKey)
  if (!account) {
    logAuthFailure(headers, "key-not-found")
    return null
  }
  return { account, dataDir: accountDataDirPath(account.id) }
}

async function accountFromActiveApiKey(apiKey: string) {
  // 账号数量很少，逐个比对即可；比对是常数时间，不泄露命中位置。
  const { listAccounts } = await import("./accounts-store")
  for (const candidate of await listAccounts()) {
    if (candidate.status !== "active") continue
    const dataDir = accountDataDirPath(candidate.id)
    // 主 Key 先判，命中就不用读临时 Key 文件，日常调用不增加磁盘开销。
    if (await verifyAccountApiKey(dataDir, apiKey)) {
      return candidate
    }
    // 临时 Key 是额外通道：过期即失效，且绝不改动主 Key。
    if (await verifyTempKey(dataDir, apiKey)) {
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

/**
 * 本机专属能力（操作当前这台电脑上的 Codex 桌面端）在服务器部署下没有意义。
 *
 * 服务器进程运行在远端，`inject` / `launch` / `restart` 这类动作只会碰到
 * 服务器自己的文件系统，既做不到用户想要的事，还会暴露一条可以拉起进程的写入口。
 * 这里统一回 501，本机壳模式完全不受影响。
 */
export function localOnlyUnsupportedResponse() {
  return Response.json(
    {
      error: {
        message: "该接口只能操作本机 Codex 桌面端，服务器部署不提供此能力",
        type: "not_implemented",
      },
    },
    {
      status: 501,
      headers: { "cache-control": "no-store" },
    },
  )
}

/** 服务器模式下拒绝本机专属接口；返回 null 表示可以继续执行。 */
export function localOnlyGuard() {
  return accessAuthRequired() ? localOnlyUnsupportedResponse() : null
}
