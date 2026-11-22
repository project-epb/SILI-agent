# SILI Linux Agent 与统一插话语义

## Goal

SILI 只能在 QuickJS 里跑纯 JS，做不了真正的 agent 工作（装包、跑脚本、处理文件、长任务）。给她一台持久的 Linux 机器和配套工具；同时把私聊「新消息即打断」改成常规 harness 的插话语义，否则长任务会被随口一句补充砍掉。

## Scope

- In：单例 unkernel Linux VM；`exec` / `write_file` / `edit_file` / `read_file` / `send_file` 工具；后台任务与完成通知；QQ 收到的图片和文件落盘到 VM；网络出站过滤；所有会话统一为插话 + 停止关键词；删除 `run_code_sandbox`。
- Out：多租户（每人/每群各一台机器）、对公众开放、VM 快照/备份、浏览器、多 CPU。

## Decisions

### 机器

1. 全局一台 VM：sili-core 用 npm 包 `unkernel`（锁定精确版本）启动 Alpine，1 CPU、512 MiB，首次调用工具时懒启动。VM 以 inline 模式跑在我们自己的 worker 线程里，不用 unkernel 的 `worker: true`。
   Why：主人选「全局一台、只给我开」，单例最简单。服务器 2 核 3.5G，可用约 2.2G。本机 bun 1.4.3 实测：冷启动加首条命令约 3 秒，`apk add python3` 6 秒，Python 百万次循环 0.8 秒。unkernel 的 worker 模式只接受内置的 direct/wisp 网络后端，挂不上自定义过滤后端；inline 跑在主线程又会让访客计算卡住机器人，所以自己开线程。
   Rejected：Docker 容器做沙盒——sili-core 本身就在容器里，要么挂 docker.sock（等于给宿主 root），要么 DinD；unkernel 在进程内就有 wasm 边界。

2. 持久化靠 unkernel 数据盘（4 GiB 稀疏 ext4 镜像），放在 `data/linux/`（宿主卷）里，distro 镜像缓存也在这里。根文件系统的改动（`apk add`、HOME、`/workspace`）都在数据盘上。每条命令结束 1 秒后、以及关机和重启前，都会 `sync` 一次。
   Why：数据盘本身持久，用不着 only-chat 那套单元备份/恢复。访客写入先停在页缓存里，进程不 sync 就退出会丢数据（实测）。

3. VM 退出（panic、wasm trap、OOM）后，正在执行的工具返回错误；下一次调用自动重启 VM。
   Why：README 写明内核 wasm trap 会结束整个会话，只能重启。

4. 命令以 `user`（uid 1000，免密 sudo）身份执行。首次启动时打开 apk 的 community 仓库，装上 bash、python3、py3-pip、curl、jq、git、ripgrep、file，装完写标记文件，之后不再重复。每次开机再以 `user` 身份预取 unkernel kw 层的 node、bun、uv（已在 `~/.local/bin` 的跳过）。
   Why：模型能用 `sudo apk add` 自行补装；提权也出不了 wasm。kw 层的这些程序是首次调用才下载的壳（node 约 200 MB），不预取的话第一次调用会撞上 30 秒超时。

5. 所有文件操作（读写、编辑、`send_file`、收件箱）都用访客里的命令通过 stdin/stdout 传字节，不把宿主目录挂进访客。
   Why：unkernel 的 `nodeFs` 只对路径最后一段加了 `O_NOFOLLOW`；访客有 sudo，root 能直接通过 vsock 发原始 9p 请求，让宿主顺着中间的符号链接越出目录。

### 网络

6. 自写 `NetBackend`：`lookup` 走宿主解析；`connect` 拒绝私有、回环、链路本地、CGNAT 和 docker 网段的目标 IP，放行的连接经 mihomo（`mihomo.sili.local:7897`）的 HTTP CONNECT 出站。
   Why：`directBackend()` 让访客能连到进程能连到的一切，sili-core 所在网络上有无密码的 mongo、napcat 和 CPA 网关。

### 工作目录

7. HOME（`/home/user`）全局共享；每个会话有一个默认 cwd `/workspace/<会话key>`，群和私聊各自独立，首次使用时创建。
   `exec` 的说明写明：其他会话的目录原则上不翻看、引用或改动，除非主人明确要求。
   Why：参照 only-chat，一个会话的产出默认留在自己的目录里，HOME 里放跨会话的工具和配置。目录之间没有权限隔离（同一个 `user`），靠说明约束。

8. 每次 `exec` 都从 `cwd` 参数指定的目录开始，没传就从会话目录开始；`cd` 只在本次调用里有效。命令结束时如果停在了别的目录，在工具结果里提醒她：下一次会回到默认目录，要留在那边就传 `cwd`。
   Why：照搬 only-chat 的 TRACK_CWD 做法，状态不会在调用之间悄悄漂移。

### 工具

9. `exec(command, cwd?, timeout_ms?, background?)`：前台默认 30 秒、上限 10 分钟。每个流保留前 4 KiB 和后 16 KiB，完整输出写进日志文件，路径随结果返回。`background: true` 立即返回任务 id、pid 和日志路径，结束后发出完成通知（见 15）。
10. `write_file(path, content)`、`edit_file(path, old, new, replace_all?)`（字面匹配，必须唯一，否则报错）、`read_file(path, offset?, limit?)`（带行号的文本）。相对路径按会话目录解析。
   Why：参照 only-chat 的工具形状；用专门工具写文件，避免 heredoc 和 sed 的转义问题。
11. `send_file(path, caption?)`：把 VM 里的文件发到当前 QQ 会话，图片作为图片消息，其他文件作为文件消息。
12. QQ 收到的图片和文件，在已开通本功能的会话里，下载到 `<会话目录>/inbox/` 下，信封里用协议标签标出 VM 内路径。
13. 机器使用说明写在 `exec` 的工具描述里，不写进 `SILI-vN.prompt.md`，也不进 system prompt。
    Why：工具只在开通的会话里出现，说明随工具出现，又不会让共享的 system prompt 缓存分成两份。
14. 删除 `run_code_sandbox`、它的运行时服务和 QuickJS 依赖。
    Why：主人说实际上没怎么用过。

### 权限

15. 新增指令 `linux`（等级 100，op 权限；`linux` 查看状态，`linux.restart` 重启）。工具定义在所有会话里都列出，描述写明只在开通的聊天可用；未开通的会话调用时在派发处拒绝。开给主人私聊和沙盒群。开通的会话每轮工具迭代上限提高到 40。
    Why：功能等级是挂在指令上的，用同一套机制，不另起访问控制。工具列表是缓存前缀的一部分，不能随功能开关或权限变化（koishi 指令目录同理：全局一份，执行时鉴权）。原来 5 次迭代不够 agent 干活。

### 后台任务通知

16. 后台任务结束后，生成一条 `<task_notification>`（任务 id、退出码、耗时、日志尾部），投进该会话的收件箱：会话有轮次在跑时按插话注入；空闲时放进 backlog，并开一轮没有用户消息的新轮次。

### 插话与停止（所有会话）

17. 私聊不再「新消息即打断」，和群聊统一走收件箱：插话在每次工具结果之后注入；最终回复输出期间到达的插话，在本轮结束后立即开新一轮处理；多条插话各自用信封包裹，放在 `steer_notice` 里。
    Why：主人要常规 harness 语义。现在私聊的 abort 会砍掉正在输出的正文、压缩和工具调用，对 agent 不可接受。

18. 消息开头是停止关键词（`停`、`停止`、`停下`、`stop`、`闭嘴`、`别说了`、`住口`，不区分大小写），且后面紧跟消息结尾、空白或标点时，按「停止键」处理：用现有的 abort 结束正在跑的轮次，并终止它的前台 `exec`。关键词后面没有内容就不回复；有内容就把剩余部分当作新消息开一轮，带上现有的中断说明。
    Why：IM 没有停止按钮，用关键词代替。要求后面紧跟边界，是为了排除「停车场怎么走」这类误判。

19. 群里只有正在跑的轮次的发起人、群管（权限 ≥ 3）和 op 能用停止关键词；其他人的这类消息按普通插话处理。
    Why：防止任意群友打断别人的任务。

20. 一轮记录所有说过话的人（发起人、插话、并入的 backlog；任务通知不算）。`execute_koishi_command` 有 `as_uid` 参数：只有一人说过话时可省略；两人及以上时必须传，且只能是这些人之一，指令用那人的 session 执行。结果第一行写明「以 X（uid N）的身份执行了 `cmd`」。agent 的 help 详情写出指令的权限等级和高于它的选项权限。
    Why：插话后整轮仍是发起人的 session，A 让改名、B 插话也要改名时，指令会作用到错的人身上。

## Acceptance

- 沙盒群里让 SILI `pip install` 一个包并跑一段脚本，能拿到结果；sili-core 重启后包和文件都还在。
- 在 VM 里 `curl` 宿主的 mongo（`sili-mongo:27017`）、`127.0.0.1`、`10.x`、`172.16-31.x`、`192.168.x` 都被拒绝；`curl https://example.com` 成功。
- 两个会话各自的默认目录互相独立；`cd /tmp && pwd` 之后，下一次 `exec` 回到会话目录，且上一次的结果里有提醒。
- 后台跑 `sleep 60; echo done`，SILI 先回复用户；60 秒后通知触发新一轮，她汇报结果。
- 在私聊连续追加两条消息时，正在跑的工具不中断，两条都能在后续轮次里看到；单发「停」立即停止且不回复；「停，改用 Python」停止后按新要求继续。
- 群里非发起人发「停」，不会打断。
- 群里 A 发起一轮、B 插话后，不带 `as_uid` 调指令被拒绝并列出 A、B；带 B 的 uid 时指令作用在 B 身上。
- 发一张图给 SILI，她能在 `inbox/` 下找到这张图；她能用 `send_file` 把生成的 PNG 发回来。
- 未开 `linux` 的会话调用这些工具被拒绝，工具列表与开通的会话相同；`run_code_sandbox` 已不存在。

## Open questions

- 后台任务跑得比被动回复窗口长时，通知那一轮怎么回复：主动消息有额度限制。先做被动，超出窗口再看实际情况。
