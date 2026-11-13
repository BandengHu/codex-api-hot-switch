# SwitchGate 服务器部署

服务器只从 `main` 构建，不再维护独立业务分支。构建产物是**自包含目录**，
服务器不需要 Git、pnpm 或源码，只需要 Node 运行时。

## 目录布局

```text
/opt/switchgate/
  app/                      构建产物（本仓库 dist/server 的内容）
  data/                     运行数据，升级时绝不清空
  tls-proxy.cjs             HTTPS 反向代理入口
  cert-hooks/               certbot DNS-01 hook（无密钥）
  acme-venv/                certbot 与腾讯云 SDK
/etc/switchgate/
  dnspod-credentials.json   DNSPod 凭据，权限 600，不入库
```

监听关系：

```text
443  tls-proxy.cjs  ->  127.0.0.1:54141  app/start.cjs
```

## 构建

```bash
npm ci
npm run build:server
```

`build:server` 会：

1. 用独立目录 `.next-server` 执行 `next build`，不影响本机 `.next`。
2. 展开 standalone 里的 junction，删除多余的 `.pnpm` 副本。
3. 补入 `@next/env` 与 `@swc/helpers`（Next standalone 在 Windows 下不会自动带入）。
4. 复制 `BUILD_ID`、路由清单、客户端静态资源。
5. 输出 `dist/server/`，并写入 `BUILD_INFO.json`。

`BUILD_INFO.json` 里的 `nextBuildId` 就是服务器上的 `.next/BUILD_ID`，
部署后可直接核对。

## 部署

```bash
STAMP=$(date +%Y%m%d-%H%M%S)
systemctl stop switchgate-tls switchgate
mv /opt/switchgate/app /opt/switchgate/app.backup-$STAMP
mv /opt/switchgate/dist-server /opt/switchgate/app
cp /opt/switchgate/app/tls-proxy.cjs /opt/switchgate/tls-proxy.cjs
systemctl start switchgate switchgate-tls
```

`/opt/switchgate/data` 不在替换范围内，账号池、访问密钥和运行配置不会被覆盖。

## 回滚

```bash
systemctl stop switchgate-tls switchgate
mv /opt/switchgate/app /opt/switchgate/app.failed
mv /opt/switchgate/app.backup-<STAMP> /opt/switchgate/app
systemctl start switchgate switchgate-tls
```

## 证书

- 证书：Let's Encrypt，`/etc/letsencrypt/live/switch.ztsnss.cloud/`
- 续期：`switchgate-certbot-renew.timer`，每天 03:17 检查
- DNS-01：`cert-hooks/dnspod-auth.py`，凭据来自 `/etc/switchgate/dnspod-credentials.json`
- 续期成功后 `renew_hook` 会重启 `switchgate-tls.service`

证书 hook 内不得写入 SecretId / SecretKey；凭据只放在 `/etc/switchgate/`。

## systemd

模板在 `deploy/server/systemd/`，安装：

```bash
cp deploy/server/systemd/*.service deploy/server/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now switchgate switchgate-tls switchgate-certbot-renew.timer
```

