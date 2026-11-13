# v5 访问控制与管理页面设计

官方 QQ bot 在后台开放后，任何人都能把它拉进任意群、也能私聊它。旧 SILI 靠「只有好友能拉群、手动点接受」控制成本和风险，`v5` 没有这道闸门，改为：**默认不受理，由管理员显式激活**。并提供一个 Koishi 控制台页面来查看和操作。

## 目标 / 非目标

- 目标：群和私聊都默认静默；`authority ≥ 4` 的管理员可随时激活或取消；能看到机器人被拉进了哪些群、被哪些人私聊过。
- 非目标：阻止机器人被拉进群（平台不支持，事件是事后通知）；机器人主动退群（没有接口）；更细粒度的功能门槛（花钱或高算力功能的分级开关等），另行单独设计。

## 规则

- **op = `authority ≥ 4` 的 Koishi 用户。** 不另建名单。op 通过用户迁移把官方身份绑到老用户后生效。
- **群**：`v5` 对 `qq` 平台关闭 `autoAssign`（它是 `Computed<boolean>`，只对 `qq` 平台关闭）。没有受理人的群里，只有 @ 机器人的消息才会被处理（Koishi 核心行为），管理员在群里 `@bot assign` 激活，`@bot assign -r` 取消。`assign` 本身要求 `authority 4`。
- **私聊**：默认静默，不回复任何提示。放行条件三选一：发送者是 op；命令是迁移命令（按命令名精确放行）；这个私聊频道已被激活。
- **私聊守卫必须在建用户记录之前**，否则陌生人每私聊一次就会在库里多一行用户；并且陌生人的私聊不得走到 `FallbackHandler`（它会把未匹配的消息转成 LLM 对话）。
- **私聊的「激活」**与群统一：每个私聊是一个频道（`private:<openid>`），频道受理人表示是否应答。激活只表示可以应答，**不提升权限**。
- **未激活的群和陌生私聊不记录消息内容**；自建的消息历史只记录已激活的群。
- 尊重 `C2C_MSG_REJECT` 和 `GROUP_MSG_REJECT`：用户或群关闭接收后不再主动发消息。
- **发布顺序**：以上守卫完成并验证之前，不在后台把机器人设为公开（公开后无法收回）。

## 记录表

官方没有「列出机器人所在的群」的接口，未受理的频道 Koishi 又不写库，所以单独记录。表 `qqbot_channel_seen`，主键为（机器人 appid、频道 id）：

| 字段 | 说明 |
|---|---|
| `type` | `group` 或 `private` |
| `name` | 群名，来自官方 `info` 接口，带缓存；私聊为空 |
| `memberNum` / `role` / `recvSetting` / `allowProactive` | 来自 `info` 与 `bot_state`，群才有 |
| `addedBy` | 把机器人拉进群的操作者 openid，来自 `GROUP_ADD_ROBOT` |
| `firstSeen` / `lastSeen` / `messageCount` | 首次、最近出现的时间与消息数 |

- **不存消息内容**。
- 消息数在内存里累计，约每分钟合并写一次，避免热闹的陌生群逐条写库。
- 记录来源：`guild-added`、`guild-removed` 事件，以及已受理频道之外的消息。

## 管理页面

- 新增 workspace 包 `plugins/qqbot-admin`，与 `llm-admin` 同样的模式：`ctx.console.addListener(事件, 处理函数, { authority: 4 })`，前端为不需要构建的原生 JS，只在 `v5` 里安装。
- 列表分「群」和「私聊」两栏，可筛选已激活 / 未激活 / 全部，按最近活动排序。
- 每一行有激活开关（设置或清除该频道的受理人，效果等同 `assign`），群行有「刷新群信息」。
- 私聊行显示 openid；若该 openid 已绑定 Koishi 用户，同时显示对应账号名。官方私聊事件不带昵称。
- 接口：`qqbot-admin/list`、`qqbot-admin/toggle`、`qqbot-admin/refresh`。页面不展示任何消息内容。

## 相关

- profile 机制见 `2026-11-13-sili-profiles-design.md`；迁移见 `2026-11-13-onebot-to-qqbot-migration-design.md`。
