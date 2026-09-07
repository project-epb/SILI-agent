#!/bin/bash
set -euo pipefail

# 镜像是纯运行时基座，node_modules 和 Chrome 都由 named volume 承载（见
# docker-compose.yml）。这里负责把 volume 里的内容对齐到 bun.lock 和 puppeteer
# 期望的版本——所以改依赖、升 puppeteer 都只需要 restart，不必重新打包镜像。
#
# 两步在 volume 已就绪时都是秒级（install ≈0.4s，Chrome 校验 ≈1s），因此无条件
# 执行，不要加"只在首次运行"之类的判断——那会让版本对齐悄悄失效。
# volume 为空时（首次部署 / 换机器）才会真正下载，约 400 MB 依赖 + 375 MB Chrome。

# PUPPETEER_SKIP_DOWNLOAD 不能去掉：puppeteer 在 bun 的默认信任列表里，postinstall
# 会照跑，而它直连 storage.googleapis.com（墙外）、不认 PUPPETEER_DOWNLOAD_BASE_URL，
# 于是整个 install 挂在 DNS 超时上。浏览器一律由下面那条显式命令走国内镜像装。
PUPPETEER_SKIP_DOWNLOAD=true bun install --frozen-lockfile
bun puppeteer browsers install chrome --base-url "$PUPPETEER_DOWNLOAD_BASE_URL"

# exec 让 bun 接管 PID 1，docker stop 的 SIGTERM 才能直达进程，
# 也让 `reboot` 命令的 process.exit(0) 能干净地结束容器并触发 restart policy。
exec bun start
