/**
 * 对外可用的中转地址。
 *
 * 本机模式直接用监听地址拼；服务器模式必须用公网 HTTPS 入口，
 * 因为监听地址只是 TLS 代理后面的内部端口，对外并不可达。
 */

export function formatPublicEndpoint({
  publicBaseUrl,
  listenAddress,
  port,
}: {
  publicBaseUrl?: string
  listenAddress: string
  port: number
}) {
  if (publicBaseUrl) return `${publicBaseUrl.replace(/\/+$/, "")}/v1`
  return `http://${listenAddress}:${port}/v1`
}
