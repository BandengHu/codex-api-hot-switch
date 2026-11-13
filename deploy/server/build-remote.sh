#!/bin/sh
# 在服务器上从单一主干构建并原子替换 /opt/switchgate/app。
#
# 约束：
# - 只从 main 构建，不维护服务器业务分支。
# - 运行数据 /opt/switchgate/data 不在替换范围内。
# - 旧版本保留为 app.backup-<stamp>，失败可直接回滚。
set -eu

ROOT=${SWITCHGATE_ROOT:-/opt/switchgate}
REPO=${SWITCHGATE_REPO:-$ROOT/source}
BRANCH=${SWITCHGATE_BRANCH:-main}
DIST="$ROOT/dist-server"
STAMP=$(date +%Y%m%d-%H%M%S)

cd "$REPO"
git fetch origin "$BRANCH"
git checkout -f "origin/$BRANCH"

# 服务器只有 3.6GB 内存且无 swap；限制 worker 与堆，避免构建被 OOM 杀掉。
export NEXT_TELEMETRY_DISABLED=1
export NEXT_DIST_DIR=.next-server
export NODE_OPTIONS=${NODE_OPTIONS:---max-old-space-size=2048}
export npm_config_registry=${npm_config_registry:-https://mirrors.cloud.tencent.com/npm/}

npm ci --no-audit --no-fund
npx next build
node deploy/server/build.mjs

systemctl stop switchgate-tls switchgate
if [ -d "$ROOT/app" ]; then
  mv "$ROOT/app" "$ROOT/app.backup-$STAMP"
fi
mv "$DIST" "$ROOT/app"
cp "$ROOT/app/tls-proxy.cjs" "$ROOT/tls-proxy.cjs"
systemctl start switchgate switchgate-tls

cat "$ROOT/app/BUILD_INFO.json"
