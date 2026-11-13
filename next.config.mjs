const runtimeFileSystemTraceExcludes = [
  "./.git/**/*",
  "./.next/**/*",
  "./.next-server/**/*",
  "./dist/**/*",
  "./next.config.mjs",
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  distDir: process.env.NEXT_DIST_DIR || ".next",
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  devIndicators: false,
  outputFileTracingIncludes: {
    "/api/codex-desktop/plugins": ["./scripts/codex-desktop-plugins-runner.cjs"],
    "/api/codex-desktop/model-whitelist": [
      "./scripts/codex-desktop-model-whitelist-runner.cjs",
      "./node_modules/ws/**/*",
    ],
    "/api/wecom-bridge": [
      "./integrations/codexbridge/package.json",
      "./integrations/codexbridge/src/**/*",
      "./integrations/codexbridge/docs/command-skills/**/*",
      "./integrations/codexbridge/packages/mission-control/src/**/*",
      "./node_modules/tsx/**/*",
      "./node_modules/zod/**/*",
      "./node_modules/@openai/agents/**/*",
      "./node_modules/@wecom/aibot-node-sdk/**/*",
      "./node_modules/axios/**/*",
      "./node_modules/eventemitter3/**/*",
      "./node_modules/ws/**/*",
      "./node_modules/ffmpeg-static/**/*",
      "./node_modules/ffprobe-static/**/*",
    ],
  },
  outputFileTracingExcludes: {
    "/api/codex-sessions": runtimeFileSystemTraceExcludes,
    "/api/wecom-bridge": runtimeFileSystemTraceExcludes,
    // 国际版号池会按动态路径读写数据目录，NFT 会误把整个项目卷进追踪清单，
    // 这里与上面两个路由同样处理，避免 standalone 把源码/dist 一并拷进去。
    "/api/workbuddy-global-pool": runtimeFileSystemTraceExcludes,
    "/api/workbuddy-global-pool/[uid]": runtimeFileSystemTraceExcludes,
    "/api/workbuddy-global-pool/login": runtimeFileSystemTraceExcludes,
  },
}

export default nextConfig
