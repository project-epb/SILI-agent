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

- 守卫需要**同步**读取，所以启动时把已激活的群、已激活的私聊用户、op 的 openid 加载进内存缓存。`assign` 命令执行后、管理页面切换后、用户 `authority` 变更后同步刷新缓存。
- `v5` 对 `qq` 平台关闭 `autoAssign`，未激活的群在 `channel` 表里没有记录。

## 群守卫

- 挂在 `attach-channel` 钩子：它在核心中间件里以 `serial` 触发，此时频道已读出、用户尚未创建，返回非空值即中断整条消息的处理。
- 未激活的群：除白名单命令外一律中断。白名单只有 `assign` 和群迁移命令。判断方式：取去掉 @ 之后内容的第一个词，与命令名及别名比较。
- `qq` 平台按激活状态判断；`onebot` 平台一律中断（绑定码已在更早的前置中间件处理），见「迁移期的 OneBot 会话」。其他平台（Discord、钉钉等）不受守卫影响，保持原有行为。

## 私聊守卫

核心对私聊不检查频道和受理人，所以私聊守卫要自己做，并且两处同时做：

1. **前置中间件**（`ctx.middleware(fn, true)`）：未放行的私聊直接丢弃。前置中间件之间的先后取决于注册顺序，它必须排在 `FallbackHandler`、plugin-auth、`session.prompt` 等其他前置中间件之前。
2. **`autoAuthorize` 按会话计算**：未放行的私聊返回 0，Koishi 只返回不写库的临时用户。这一处挡住 `session.execute` 自带的建用户（`FallbackHandler` 和 LLM 的命令工具都走这条路）。计算函数必须同步、只读内存缓存：返回 Promise 会被当成真值，照样建用户。

放行条件三选一：发送者是 op；该用户的私聊已激活；消息是 `bind` 命令或它的别名「多账号绑定」（按命令名和别名精确匹配，用户迁移和跨平台绑定都靠它；私聊菜单按钮填进输入框的就是这个别名）。未放行的私聊不回复任何提示。

对 `bind` 放行时，`autoAuthorize` 必须返回 1，为发起者建用户和绑定记录：plugin-bind 最后一步用 minato 的 `set` 改写发起方的绑定行，`set` 只更新已有的行，没有这一行时插件会回复「绑定成功」，实际什么都没写。

## 迁移期的 OneBot 会话

迁移期间 `v5` 额外加载 OneBot 适配器（以 `ONEBOT_SELFID` 是否设置为开关），它**只用于接收 `bind` 的绑定码**。

- `onebot` 平台的会话**一律视为未服务**，不看 `assignee`：生产库里约 60 个 OneBot 群的 `channel` 记录，`assignee` 仍是 SILI 的 QQ 号，而 OneBot 适配器的 `selfId` 正是这个号，核心会把它们当成已受理。
- 绑定码由 plugin-bind 自己的前置中间件处理：消息内容恰好等于某个有效绑定码时完成绑定并中断，否则交给下一个处理者。它在 `attach-channel` 之前触发，所以群守卫不会挡住它；其余 `onebot` 消息由群守卫一律中断。实现时要实测这个先后。
- plugin-bind 在这一步直接按发码者查 `binding` 找旧用户，不新建用户；`autoAuthorize`、`autoAssign` 对 `onebot` 返回 0 / `false`，其余路径也不会建用户和频道。
- 消息存储和元数据表都不记 `onebot` 的消息。

## `on('message')` 监听器

中间件守卫拦不住 `ctx.on('message')` 监听器（由 satori 直接逐个触发）。`v5` 里任何此类监听器都必须装在 `ctx.intersect(是否已服务)` 的过滤上下文里，过滤函数同步、读缓存。`onebot` 平台的会话在过滤函数里一律返回 false。

## 消息存储 `qqbot_message`

- **存什么**：已激活的群和已放行的私聊里的**全部**消息事件（包括其他 bot、非命令消息），以及机器人自己发送成功的消息（官方不会把机器人自己的消息推回来，必须在发送成功后自己入库）。未激活的群和未放行的私聊**不存内容**。
- **字段**：appid、频道 id（群 openid 或 `private:<openid>`）、消息 id、发送者 openid、发送者名称、是否 bot、是否机器人自己、内容、@ 列表、引用编号、时间。
- **去重**：唯一索引（appid、频道 id、消息 id）。写入放在**最前面的前置中间件**里，撞键即视为重复推送（官方会重复推送同一条消息），中断这条消息的全部处理。
- **保留 30 天**。优先用 Mongo 的 TTL 索引；Koishi 的数据库层不能声明时改用定时清理。
- **读取方**：LLM 的 `read_channel_history`（`qq` 平台改读这张表）；who-asked（改读这张表的 @ 列表，`v5` 不再写 `mention_logs`）；管理页面。
- `v5` 不装 `MessagesLogger`（文件日志），由这张表取代。

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
- 并发 upsert 撞唯一键时改为更新重试；所有写入的异常都必须捕获。

## 事件

- `guild-added`（`GROUP_ADD_ROBOT`）只带 `guildId` 和操作者，不带 `channelId`。
- 群消息开关：适配器发出的是非标准事件名 `group-msg-reject` / `group-msg-receive`，写进 `qqbot_channel` 的收消息字段；拒收的群在 `before-send` 钩子里拦截主动消息。
- `C2C_MSG_REJECT` 适配器不处理，私聊的拒收暂时无法遵守。

## 管理页面

- workspace 包 `plugins/qqbot-admin`，与 `llm-admin` 相同的模式：`ctx.console.addListener(事件, 处理函数, { authority: 4 })`，前端为不需要构建的原生 JS，只在 `v5` 里安装。
- 群列表、用户列表，可筛选已激活 / 未激活 / 全部，按最近活动排序；可以按群查看出现过的用户、按用户查看出现过的群（`qqbot_member`）。
- 群行开关：设置或清除 `channel.assignee`（没有行时新建，`guildId` 为群 openid），效果等同 `assign`；另有「刷新群信息」。用户行开关：`dmActive`。切换后同步刷新守卫缓存。
- 首版不展示消息内容。
- op 登录控制台需要设置密码。plugin-auth 的平台登录会改写 `binding`，与迁移冲突。

## 其他约束

- `v5` 装 `@koishijs/plugin-bind`，用于用户迁移和跨平台账号绑定，文案在迁移 spec 里覆盖。
- 共存期间群里同时有两个 SILI：OneBot 会话在 `attach-channel` 就被拦下，这一步早于 Koishi 读取用户，所以 OneBot 一侧不会写入任何用户数据。
- 发布顺序：群守卫、私聊守卫、监听器过滤完成并验证之前，不在后台把机器人设为公开（公开后无法收回）。用户迁移需要普通用户能私聊机器人，所以迁移功能上线晚于守卫。

## 待验证

- Koishi 会缓存 observed 的频道对象，管理页面直接写库后，缓存里的 `assignee` 是否会短时间内是旧值；守卫以自己的缓存为准时，如何保证与 `channel` 表一致。
- 群守卫在 `attach-channel` 时能否可靠取到命令名（`session.stripped` 此时是否可用）。
- 私聊前置中间件与其他前置中间件的实际先后。
- `on('message')` 监听器与中间件的触发先后，以及去重能否同时覆盖两者。
- Koishi 的数据库层（minato）能否声明 TTL 索引。
- plugin-auth 的平台登录能否关闭。
- plugin-bind 的前置中间件是否确实排在 `attach-channel` 守卫之前，OneBot 群里的绑定码能被处理。
- 在同时有两个 SILI 的群里，已迁移用户发一条消息，只有官方 bot 回复一次，且 OneBot 一侧没有写入任何用户数据。

## 相关

- profile 机制见 `2026-11-13-sili-profiles-design.md`；迁移见 `2026-11-13-onebot-to-qqbot-migration-design.md`。
