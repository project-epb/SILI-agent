# SILI Linux 机器管理页

## Goal

主人维护 SILI 的 Linux 机器（装东西、看文件、查问题）只能借 SILI 之手或写临时脚本。给 Koishi 控制台加一个管理页：终端、文件管理器、状态面板。

## Scope

- In：xterm.js 终端（PTY，交互式）；文件浏览、下载、上传、删除、新建目录、文本在线编辑；状态面板（运行状态、磁盘/内存、后台任务及 kill、重启机器）。
- Out：断线重连 / 会话保持、多人协作终端、给非管理员开放。

## Decisions

1. 管理页是 `plugins/linux-admin`，结构照 sticker-admin：原生 JS + Vue 的 client，后端用 `ctx.console.addListener` 提供 RPC。只有登录控制台的管理员能用。
   Why：与现有四个管理页同一套，不另起服务和鉴权。

2. 终端走 unkernel 的 PTY：`spawn` 带 pty，`write` 输入、`resize` 改窗口、读 `output` 流。VM 在我们自己的 worker 里，worker 协议补上 pty 的 open / input / resize / kill / output / ended 消息。输出用发起 RPC 的那个控制台 client 的 `send` 推给它，不 `broadcast`。
   Why：PTY 能力 unkernel 自带；broadcast 会把一个人的终端输出推给所有打开控制台的人。

3. 终端默认以 `user` 身份打开，页面上可切换为 root。浏览器关闭、刷新或断开时，终端会话随之结束（hang up），不做重连。
   Why：主人选不做会话保持；与 SILI 执行命令的身份一致，root 按需切。

4. 前端终端用 xterm.js，文件 vendor 进仓库，不走 CDN。
   Why：term.js 已停更，xterm.js 是它的后继；控制台 client 没有打包步骤，vendor 最稳。

5. 文件管理器的所有操作都在 VM 里用命令经 stdin/stdout 传字节（复用 LinuxMachine 的 readFile / writeFile / run），不挂载宿主目录。单文件上传、下载上限 50 MiB。文本编辑对 UTF-8 文本、1 MiB 以内的文件开放。
   Why：沿用 linux-agent spec 决定 5（root 可绕出 9p 挂载）。

6. 状态面板：运行状态与启动时间、`df` / `free` 的结果、`/workspace/.jobs` 下的后台任务（命令、开始时间、是否在跑），可 kill；「重启机器」调用现有的 `LinuxMachine.restart()`。
   Why：主人维护时最常看的就是这些；restart 已有实现。

## Acceptance

- 控制台打开管理页，终端里能跑 `htop`、`vim`、Tab 补全和 Ctrl+C；改浏览器窗口大小后 `tput cols` 随之变化；切到 root 后 `id` 为 0。
- 关掉页面后，VM 里那个 shell 进程消失。
- 两个浏览器各开一个终端，输出互不串。
- 文件管理器能浏览 `/workspace` 和 HOME，下载、上传（含二进制）、删除、新建目录、编辑保存文本文件；超过 50 MiB 的上传被拒绝并提示。
- 状态面板显示磁盘、内存和后台任务；kill 一个后台任务后它显示为已结束，SILI 收到对应的 `<task_notification>`；重启按钮能重启机器。
- 未登录控制台的人访问不到这些 RPC。
