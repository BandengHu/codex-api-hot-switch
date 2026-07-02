const runtimeFileSystemTraceExcludes = [
  "./.git/**/*",
  "./.next/**/*",
  "./.electron-server/**/*",
  "./.electron-shell/**/*",
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
  },
}

export default nextConfig
