import "server-only"

/** 显式配置的公网入口，例如 https://switch.example.com。 */
export const PUBLIC_BASE_URL_ENV = "SWITCHGATE_PUBLIC_BASE_URL"

/**
 * 服务器模式下对外暴露的中转入口。
 *
 * 进程监听的是 TLS 代理后面的内部端口，界面绝不能把它当成调用地址；
 * 优先用显式配置，其次用反向代理传入的原始协议与主机名。
 */
export function resolvePublicBaseUrl({
  configured,
  proto,
  host,
}: {
  configured?: string
  proto?: string | null
  host?: string | null
}): string {
  const explicit = String(configured || "").trim()
  if (explicit) return explicit.replace(/\/+$/, "")

  const hostname = String(host || "").trim()
  if (!hostname) return ""
  const scheme = String(proto || "").trim() === "https" ? "https" : "http"
  return `${scheme}://${hostname}`
}
