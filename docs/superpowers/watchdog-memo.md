# SILI 存活监控备忘

SILI 本身足够稳定（有过连续两个月不重启的记录，期间只有 napcat 掉线）。下面是再次出事时的方案储备，现在不做。

## 已发生的两次死亡

- **sql.js 内存越界**（2026-11-25 23:59）：WASM SQLite 报 `Out of bounds memory access`，进程和 HTTP 都活着，所有数据库读写失败约两小时，重启恢复。已改用原生 SQLite 驱动（`SILI_SQLITE_DRIVER=native`）。
- **整机卡死**（2026-11-24 前后）：mongo 容器内存不足，备份任务触发高频 swap，整台服务器无响应。mongo 已退役。

两次都说明：只看进程或端口不够；整机卡死时机内的一切检查都会跟着卡住。

## 方案（分层，各管一类故障）

1. **`GET /health`**（Koishi server，3100）：真查一次数据库（带超时）、检查 QQ 适配器在线；全好 200，否则 503 并写明哪项失败。经 Caddy 对外暴露须带 token。
2. **docker 健康检查 → 自动重启**：docker 只标记 `unhealthy`，不会重启。做法：容器内检查脚本每 30 秒请求 `/health`，失败计数写临时文件，连续 3 次就结束主进程，交给 `restart: unless-stopped` 拉起。compose 需 `init: true`（tini 作 1 号进程），否则 1 号进程忽略 SIGTERM。备选是 autoheal 边车容器，但服务器拉 Docker Hub 被拒，要本机拉镜像再传。
3. **外部看门狗**（本机 launchd，每分钟）：请求 `/health`，超时约 10 秒；连续 3 次失败用 `qq-notify` 通知（SILI 自己就是 QQ 机器人，挂了没法自报）。随后起一个 `claude -p` ssh 上去看日志、诊断并汇报；只授权重启 core，其他操作等确认。ssh 不通时直接报告"整机无响应，需阿里云控制台强制重启"。本机睡眠时看门狗停摆。
4. **防整机卡死**：装 `earlyoom`，内存将尽时杀最大进程（常是 VS Code Remote server）而不是全机 swap 卡死；Linux VM 的每日磁盘备份套 `nice` / `ionice` 降优先级。
