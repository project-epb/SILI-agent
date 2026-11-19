#!/bin/bash
set -euo pipefail

# 镜像是纯运行时基座，node_modules 由 named volume 承载（见 docker-compose.yml）。
# 这里负责把 volume 对齐到 bun.lock——所以改依赖只需要 restart，不必重新打包镜像。
#
# volume 已就绪时 install 是秒级（≈0.4s），因此无条件执行，不要加"只在首次运行"
# 之类的判断——那会让版本对齐悄悄失效。volume 为空时（首次部署 / 换机器）才会
# 真正下载，约 400 MB。浏览器不在 core 里，在 browser 容器。
bun install --frozen-lockfile

# exec 让 bun 接管 PID 1，docker stop 的 SIGTERM 才能直达进程，
# 也让 `reboot` 命令的 process.exit(0) 能干净地结束容器并触发 restart policy。
exec bun start
