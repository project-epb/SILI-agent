# v5 访问控制、消息存储与管理页面设计

官方 QQ bot 在后台开放后，任何人都能把它拉进任意群、也能私聊它。旧 SILI 靠「只有好友能拉群、手动点接受」控制成本和风险，`v5` 改为：**未激活的群和用户，除明确的例外，任何消息都不处理**，由 op 显式激活。同时建立官方 bot 侧的消息存储（官方没有历史接口），以及一个 Koishi 控制台管理页面。

## 目标 / 非目标

- 目标：未激活的群和私聊完全不处理；op 可在群里或控制台随时激活、取消；记录机器人见过的群、用户和群成员（元数据）；已激活的群和私聊保存完整消息并去重。
- 非目标：阻止机器人被拉进群（平台不支持，事件是事后通知）；机器人主动退群（没有接口）；更细粒度的功能门槛（花钱或高算力功能的分级开关等），另行单独设计；`v4` 的任何改动。

## 身份前提

- 同一机器人下，同一个人在所有群和私聊里的 openid 相同；群 openid 按机器人区分；不同机器人之间无法换算。所以 op 在私聊完成迁移后，在群里也是 op。
- Koishi 的 `binding` 表没有 appid 列，而 openid 只在当前机器人下有效，appid 记在 `qqbot_user` 里。

## op

`authority ≥ 4` 的 Koishi 用户，不另建名单。`assign` 命令本身也要求 `authority 4`。

## 激活状态

| 对象 | 存放位置 |
|---|---|
| 群 | `channel.assignee`（Koishi 原生字段，`assign` 命令和守卫都用它） |
| 私聊 | `qqbot_user.dmActive` |

- 守卫需要**同步**读取，所以把已激活的群、已激活的私聊用户、op 的 openid 加载进内存缓存：启动时加载，之后每 30 秒整体重载一次；`assign`、管理页面、群迁移改动后立即更新。用户 `authority` 的变化（例如新 op 完成绑定）最多 30 秒后生效。
- `v5` 对 `qq` 平台关闭 `autoAssign`，未激活的群在 `channel` 表里没有记录。

## 守卫的分层

实现见 `src/plugins/qqbot/`（判断逻辑是纯函数，在 `gate.ts`，有单测）。三层同时生效：

1. **已服务上下文**：`v5` 里除少数例外，所有插件都装在 `app.intersect(是否已服务)` 构造的上下文里。Koishi 派发中间件、事件监听、匹配命令时都按注册时的上下文过滤，所以未服务的会话根本到不了这些插件，包括它们的前置中间件（`FallbackHandler` 等）和 `ctx.on('message')` 监听器。例外只有：适配器、qqbot 服务、plugin-admin（`assign`）、plugin-bind。新插件一律装进已服务上下文。
2. **一个前置中间件（gate）**：由 qqbot 服务注册。核心的 `attach` 是 App 构造时注册的第一个前置中间件，之后注册的前置中间件都排在它前面，所以 gate 总在 Koishi 读取频道和用户之前执行。它负责：放行已服务的会话；对未服务的会话只放行少数命令，其余一律静默丢弃；消息去重和入库（见下文）；记录元数据。
3. **App 选项** `autoAuthorize` / `autoAssign`：对未服务的会话不建用户、不建频道，挡住 `session.execute` 等其他路径。两个函数都必须同步、只读内存缓存：返回 Promise 会被当成真值，照样建用户。

`qq-crack` 默认会把消息里的用户名写回 Koishi：对没见过的发送者直接建用户，权限取 `autoAuthorize || 1`。这条路径绕过上面三层，而且 `autoAuthorize` 是函数时权限字段存不进去，建出来的用户等同 0 级（连 `bind` 后续流程都会失败）。所以 `v5` 必须给适配器设 `disableUserNamePersist: true`，用户名由 `qqbot_user` 记录。

「已服务」的判断：

- `qq` 与 `qqguild`（QQ 频道）：群按激活状态，私聊按「发送者是 op，或该用户的私聊已激活」。
- `onebot`：一律未服务，不看 `assignee`（见下文）。
- 其他平台（Discord、钉钉等）：一律已服务，保持原有行为。

未服务时 gate 放行的命令（按去掉 @ 和一个命令前缀后的第一个词，与命令名及别名比较）：

- **未激活的群**：`assign`、群迁移命令，**只对 op 放行**。若对所有人放行，非 op 会收到 Koishi 的「权限不足」，等于在应当忽略的群里开口。
- **未服务的私聊**：`bind` 及别名「多账号绑定」，对所有人放行（用户迁移和跨平台绑定都靠它，私聊菜单按钮填进输入框的就是这个别名）。放行时 `autoAuthorize` 返回 1，为发起者建用户和绑定记录：plugin-bind 最后一步用 minato 的 `set` 改写发起方的绑定行，`set` 只更新已有的行，没有这一行时插件会回复「绑定成功」，实际什么都没写。

## 迁移期的 OneBot 会话

迁移期间 `v5` 额外加载 OneBot 适配器（以 `ONEBOT_SELFID` 是否设置为开关），它**只用于接收 `bind` 的绑定码**。

- `onebot` 平台的会话**一律视为未服务**，不看 `assignee`：生产库里约 60 个 OneBot 群的 `channel` 记录，`assignee` 仍是 SILI 的 QQ 号，而 OneBot 适配器的 `selfId` 正是这个号，核心会把它们当成已受理。
- gate 只放行以绑定码前缀（plugin-bind 默认的 `koishi/`）开头的 OneBot 消息，交给 plugin-bind 的前置中间件处理；其余全部静默丢弃。
- plugin-bind 按发码者查 `binding` 找旧用户，不新建用户；`autoAuthorize`、`autoAssign` 对 `onebot` 返回 0 / `false`，其余路径也不会建用户和频道。
- 消息存储和元数据表都不记 `onebot` 的消息。
- 共存期间群里同时有两个 SILI：OneBot 会话在 gate 就被丢弃，早于 Koishi 读取用户，所以 OneBot 一侧不会写入任何用户数据，也不会和官方 bot 一起回复。

## 消息存储 `qqbot_message`

- **存什么**：已激活的群和已放行的私聊里的**全部**消息事件（包括其他 bot、非命令消息），以及机器人自己发送成功的消息（官方不会把机器人自己的消息推回来，必须在发送成功后自己入库）。未激活的群和未放行的私聊**不存内容**。
- **字段**：appid、频道 id（群 openid 或 `private:<openid>`）、消息 id、发送者 openid、发送者名称、是否 bot、是否机器人自己、内容、@ 列表、引用编号、时间。
- **去重**：主键（appid、频道 id、消息 id）。入库在 gate 里，撞键即视为重复推送（官方会重复推送同一条消息），中断这条消息的中间件处理。已服务上下文里的 `ctx.on('message')` 监听器（如统计）不经过中间件，仍会看到重复推送。
- **保留 30 天**：启动时和每小时清理一次过期记录。
- **读取方**（阶段三接入）：LLM 的 `read_channel_history`（`qq` 平台改读这张表）；who-asked（改读这张表的 @ 列表，`v5` 不再写 `mention_logs`）。
- `MessagesLogger`（文件日志）在 `v5` 里只对 `qq` 以外的平台生效，`qq` 平台由这张表取代。

## 元数据表

官方的成员列表接口是白名单接口，也没有「列出机器人所在群」的接口；未激活的群 Koishi 又不写库。以下三张表记录「见过谁」，**不存消息内容**，激活与否都记：

- **`qqbot_channel`**（appid、群 openid）：群名、成员数、机器人角色、收消息范围、能否发主动消息（来自官方 `info`、`bot_state` 接口，带缓存，可手动刷新）；拉群人 openid（`guild-added`）；被移出时间（`guild-removed`）；首次、最近出现时间，消息数。
- **`qqbot_user`**（appid、openid）：最近一次见到的名称（群消息事件带 `username`，私聊事件不带）；首次、最近出现时间；私聊次数；`dmActive`。
- **`qqbot_member`**（appid、群 openid、openid）：首次、最近发言时间，发言数。只覆盖**发过言**的成员，不是完整的群成员名单。

对应关系：

- `qqbot_channel` ↔ `channel`（`platform = qq`，`id = 群 openid`），群被激活后才有对应行。
- `qqbot_user` ↔ `binding`（`platform = qq`，`pid = openid`）→ `user`，用户被激活或完成迁移后才有对应行。

写入：

- 计数在内存里累计，约每分钟合并写一次。
- 合并写入只对计数做增量、只更新本次负责的字段，不能覆盖「刷新群信息」「`guild-added`」写入的字段。
- 所有写入的异常都必须捕获（未捕获的 rejection 会让进程退出）。
- 首次见到一个群时排队调官方 `info`、`bot_state` 接口补全群信息，间隔约 2.5 秒（这两个接口限 30 次/分钟）。

## 事件

- `guild-added`（`GROUP_ADD_ROBOT`）只带 `guildId` 和操作者，不带 `channelId`。
- `guild-removed`：记下被移出时间，并**取消激活**，以免日后被别人重新拉进来时直接继承「已服务」。
- 群消息开关：适配器发出的是非标准事件名 `group-msg-reject` / `group-msg-receive`，记进 `qqbot_channel.recvRejected`。拒收的群目前只记录；首次激活提示在拒收的群里不会走主动消息（只走被动回复）。在 `before-send` 里拦截其他主动消息尚未实现。
- `C2C_MSG_REJECT` 适配器不处理，私聊的拒收暂时无法遵守。

## 管理页面

- workspace 包 `plugins/qqbot-admin`，与 `llm-admin` 相同的模式：`ctx.console.addListener(事件, 处理函数, { authority: 4 })`，前端为不需要构建的原生 JS，只在 `v5` 里安装。
- 群列表、用户列表，可筛选已激活 / 未激活 / 全部，按最近活动排序；可以按群查看出现过的用户、按用户查看出现过的群（`qqbot_member`）。
- 群行开关：设置或清除 `channel.assignee`（没有行时新建，`guildId` 为群 openid），效果等同 `assign`；另有「刷新群信息」。用户行开关：`dmActive`。切换后同步刷新守卫缓存。
- 用户行可设置权限等级：规则同 Koishi 的 `authorize`，新等级必须低于操作者（控制台当前登录账号）；另外不能修改权限不低于自己的账号，也不能改自己。openid 还没有账号时按设定等级新建。平台没有「机器人拥有者」接口，新机器人的第一批管理员靠这里授予（对方先给机器人发一条消息即可出现在列表里）。
- 首版不展示消息内容。
- op 登录控制台需要设置密码。plugin-auth 的平台登录会改写 `binding`，与迁移冲突。

## 其他约束

- `v5` 装 `@koishijs/plugin-bind`，用于用户迁移和跨平台账号绑定，文案在迁移 spec 里覆盖。
- 发布顺序：群守卫、私聊守卫、监听器过滤完成并验证之前，不在后台把机器人设为公开（公开后无法收回）。用户迁移需要普通用户能私聊机器人，所以迁移功能上线晚于守卫。

## 已验证

- Koishi 的频道缓存（`SharedCache`）只在消息处理期间按会话引用计数保留，处理完即释放，不按时间过期。管理页面或群迁移直接写库后，下一条消息就能读到新的 `assignee`。
- gate 中 `session.stripped` 可用，命令名识别可靠。
- 已服务上下文让前置中间件之间的先后不再影响守卫：除 plugin-bind 外，其他前置中间件都在上下文里，未服务的会话到不了它们。
- 集成测试（真实启动 `v5` + 灰度机器人在线 + 临时数据库，发送被替换为记录）：未激活群静默、非 op 的 `assign` 静默、op `assign` 激活并发出首次提示、陌生私聊静默且不建用户、别名「多账号绑定」返回新文案、OneBot 普通消息静默（包括 `assignee` 仍是 SILI 的旧群）、OneBot 群里发绑定码完成绑定、重复推送只处理一次、群迁移预览 / 执行 / 防重复、消息与元数据入库、管理页面各接口。

## 待验证

- plugin-auth 的平台登录能否关闭。
- 群收消息被关闭（`group-msg-reject`）时，是否需要在 `before-send` 拦截全部主动消息。

## 相关

- profile 机制见 `2026-11-13-sili-profiles-design.md`；迁移见 `2026-11-13-onebot-to-qqbot-migration-design.md`。
