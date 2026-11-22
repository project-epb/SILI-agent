# SILI Linux Agent 与统一插话语义

## Goal

SILI 只能在 QuickJS 里跑纯 JS，做不了真正的 agent 工作（装包、跑脚本、处理文件、长任务）。给她一台持久的 Linux 机器和配套工具；同时把私聊「新消息即打断」改成常规 harness 的插话语义，否则长任务会被随口一句补充砍掉。

## Scope

- In：单例 unkernel Linux VM；`exec` / `write_file` / `edit_file` / `read_file` / `send_file` 工具；后台任务与完成通知；QQ 收到的图片和文件落盘到 VM；网络出站过滤；所有会话统一为插话 + 停止关键词；删除 `run_code_sandbox`。
- Out：多租户（每人/每群各一台机器）、对公众开放、VM 快照/备份、浏览器、多 CPU。

## Decisions

### 机器

1. 全局一台 VM：sili-core 进程内用 npm 包 `unkernel`（锁定精确版本）启动 Alpine，`worker: true`、1 CPU、512 MiB，首次调用工具时懒启动。
   Why：主人选「全局一台、只给我开」，单例最简单。服务器 2 核 3.5G，可用约 2.2G。本机 bun 1.4.3 实测：冷启动加首条命令约 3 秒，`apk add python3` 6 秒，Python 百万次循环 0.8 秒。
   Rejected：Docker 容器做沙盒——sili-core 本身就在容器里，要么挂 docker.sock（等于给宿主 root），要么 DinD；unkernel 在进程内就有 wasm 边界。

2. 持久化靠 unkernel 数据盘（ext4 镜像），放在挂进容器的宿主卷里；distro 镜像缓存（`UNKERNEL_CACHE_DIR`）也放在同一卷里。根文件系统的改动（`apk add`、HOME）都在数据盘上，sili-core 重启后依然存在。
   Why：数据盘本身持久，用不着 only-chat 那套单元备份/恢复。

3. VM 退出（panic、wasm trap、OOM）后，正在执行的工具返回错误；下一次调用自动重启 VM。
   Why：README 写明内核 wasm trap 会结束整个会话，只能重启。

4. 命令以 `user`（uid 1000，免密 sudo）身份执行，环境里预装 python3、curl、jq、git、ripgrep，首次启动时执行一次 `apk add`。
   Why：模型能用 `sudo apk add` 自行补装；提权也出不了 wasm。

### 网络

5. 自写 `NetBackend`：`lookup` 走宿主解析；`connect` 拒绝私有、回环、链路本地、CGNAT 和 docker 网段的目标 IP，放行的连接经 mihomo（`mihomo.sili.local:7897`）的 HTTP CONNECT 出站。
   Why：`directBackend()` 让访客能连到进程能连到的一切，sili-core 所在网络上有无密码的 mongo、napcat 和 CPA 网关。

### 工作目录

6. HOME（`/home/user`）全局共享；每个会话有一个默认 cwd `/workspace/<会话key>`，群和私聊各自独立，首次使用时创建。
   Why：参照 only-chat，一个会话的产出默认留在自己的目录里，HOME 里放跨会话的工具和配置。

7. 每次 `exec` 都从 `cwd` 参数指定的目录开始，没传就从会话目录开始；`cd` 只在本次调用里有效。命令结束时如果停在了别的目录，在工具结果里提醒她：下一次会回到默认目录，要留在那边就传 `cwd`。
   Why：照搬 only-chat 的 TRACK_CWD 做法，状态不会在调用之间悄悄漂移。

### 工具

8. `exec(command, cwd?, timeout_ms?, background?)`：前台默认 30 秒、上限 10 分钟。每个流保留前 4 KiB 和后 16 KiB，完整输出写进日志文件，路径随结果返回。`background: true` 立即返回任务 id、pid 和日志路径，结束后发出完成通知（见 15）。
9. `write_file(path, content)`、`edit_file(path, old, new, replace_all?)`（字面匹配，必须唯一，否则报错）、`read_file(path, offset?, limit?)`（带行号的文本）。相对路径按会话目录解析。
   Why：参照 only-chat 的工具形状；用专门工具写文件，避免 heredoc 和 sed 的转义问题。
10. `send_file(path, caption?)`：把 VM 里的文件发到当前 QQ 会话，图片作为图片消息，其他文件作为文件消息。
11. QQ 收到的图片和文件，在已开通本功能的会话里，下载到 `<会话目录>/inbox/` 下，信封里用协议标签标出 VM 内路径。
12. 机器使用说明作为 system 段落，只在提供这些工具时注入，不写进 `SILI-vN.prompt.md`；工具描述只写调用方法。
13. 删除 `run_code_sandbox`、它的运行时服务和 QuickJS 依赖。
    Why：主人说实际上没怎么用过。

### 权限

14. 新增功能 `linux`，等级 100。工具只在该功能开启的会话里提供；开给主人私聊和沙盒群。
    Why：和 ComfyUI/NovelAI 同一套机制，不另起访问控制。

### 后台任务通知

15. 后台任务结束后，生成一条系统来源的通知（任务 id、退出码、耗时、日志尾部），投进该会话的收件箱：会话有轮次在跑时按插话注入；空闲时立即开一轮新轮次。

### 插话与停止（所有会话）

16. 私聊不再「新消息即打断」，和群聊统一走收件箱：插话在每次工具结果之后注入；最终回复输出期间到达的插话，在本轮结束后立即开新一轮处理；多条插话各自用信封包裹，放在 `steer_notice` 里。
    Why：主人要常规 harness 语义。现在私聊的 abort 会砍掉正在输出的正文、压缩和工具调用，对 agent 不可接受。

17. 消息开头是停止关键词（`停`、`停止`、`stop`、`闭嘴`、`别说了`、`住口`，不区分大小写），且后面紧跟消息结尾、空白或标点时，按「停止键」处理：用现有的 abort 结束正在跑的轮次，并终止它的前台 `exec`。关键词后面没有内容就不回复；有内容就把剩余部分当作新消息开一轮，带上现有的中断说明。
    Why：IM 没有停止按钮，用关键词代替。要求后面紧跟边界，是为了排除「停车场怎么走」这类误判。

18. 群里只有正在跑的轮次的发起人、群管（权限 ≥ 3）和 op 能用停止关键词；其他人的这类消息按普通插话处理。
    Why：防止任意群友打断别人的任务。

## Acceptance

- 沙盒群里让 SILI `pip install` 一个包并跑一段脚本，能拿到结果；sili-core 重启后包和文件都还在。
- 在 VM 里 `curl` 宿主的 mongo（`sili-mongo:27017`）、`127.0.0.1`、`10.x`、`172.16-31.x`、`192.168.x` 都被拒绝；`curl https://example.com` 成功。
- 两个会话各自的默认目录互相独立；`cd /tmp && pwd` 之后，下一次 `exec` 回到会话目录，且上一次的结果里有提醒。
- 后台跑 `sleep 60; echo done`，SILI 先回复用户；60 秒后通知触发新一轮，她汇报结果。
- 在私聊连续追加两条消息时，正在跑的工具不中断，两条都能在后续轮次里看到；单发「停」立即停止且不回复；「停，改用 Python」停止后按新要求继续。
- 群里非发起人发「停」，不会打断。
- 发一张图给 SILI，她能在 `inbox/` 下找到这张图；她能用 `send_file` 把生成的 PNG 发回来。
- 未开 `linux` 的会话看不到这些工具；`run_code_sandbox` 已不存在。

## Open questions

- QQ 官方群能否发 `file` 类型（非图片）消息，需要实测；不行的话 `send_file` 对非图片改成上传到 R2 后发链接。
- 后台任务跑得比被动回复窗口长时，通知那一轮怎么回复：主动消息有额度限制。先做被动，超出窗口再看实际情况。
