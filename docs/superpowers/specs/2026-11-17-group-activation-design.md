# 群激活与 Koishi assign 拆开

## Goal

v5 一直用 Koishi 的 `assign`（`channel.assignee`）表示「本群已开通 SILI 服务」。但 `assign` 在 Koishi 里是路由：一个群里有多个 bot 时由谁处理。两层意思绑在一起后，免激活功能用不全：Koishi 核心会丢掉未指派群里所有不 @ bot 的消息，没激活的群即使开了「接收全部消息」，不 @ 的 `[[词条]]` 也到不了插件。把路由和激活拆成两个独立的东西。

## Scope

- In：QQ 群（及 qqguild 子频道）的指派方式；独立的激活标记；激活指令；读写激活状态的所有地方（served 判断、门控、群迁移、被移出群、控制台）；现有数据的迁移；私聊的免激活功能和激活指令。
- Out：OneBot 旧号（仍然永不 served）。

## Decisions

1. **`assignee` 只表示路由。** 受保护平台上，bot 所在的群一律指派给这个 bot：频道行新建时自动指派，已有的行在门控第一次见到这个群时补上。
   Why：一个群里只有一个官方 bot，没有选择的必要；不指派的话 Koishi 核心会丢掉不 @ bot 的消息。

2. **激活是 `qqbot_channel.activated`。** 按（bot，群）记录，只表示高级功能是否开通。`ServedState` 从它读激活的群，served 过滤器、门控、聊天等一切按「是否激活」判断的地方都以它为准，不再看 `assignee`。

3. **激活指令是 `channel.activate`，`-r` 取消激活。** 别名「激活」。只有 op 能用，在未激活的群里同样放行（替代门控白名单里的 `assign`）。`assign` 回到 Koishi 原义，不再影响激活，也不做兼容。
   Why：激活是对群的设置，放在 `channel` 下面；与 `assign` 分开，才不会再混用。

4. **群迁移（`group-migrate`）、控制台开关、被移出群都改写 `activated`。** 迁移和控制台激活时设为 true；被移出群时设为 false（同时照旧清掉入群通知的标记）。

5. **现有数据一次性迁移，只跑一次**（在 `qqbot_migration` 记一条标记）：
   - `assignee` 是这个 bot 的群，在 `qqbot_channel` 里标为已激活；
   - bot 所在但没指派的群，补上指派，**不激活**（只能用免激活功能）。
   之后激活与否只看 `activated`，不再参照 `assignee`。
   Why：已开通的群行为不变；没开通的群补上路由，免激活功能完整可用。

6. **私聊沿用 `qqbot_user.dmActive`，规则与群对齐。** 未激活的私聊可用 `help`、`about`、`dice`、`sticker`（含 manosaba），另外照旧放行 `bind`；`wiki`、`github` 在私聊里用不了，不放。其余功能（含 LLM）需要激活，调用时提示找小鱼君（824399619）激活，每人 8 小时最多一次。私聊不发权限提示。
   Why：陌生人私聊也能用日常功能；会花钱的功能仍要先激活。

7. **私聊激活指令是 `user.activate <用户>`，`-r` 取消激活。** 只有 op 能用，效果与控制台的私聊开关相同。

## Acceptance

- 已激活的群上线后照常可用所有功能，未激活的群照常只能用免激活功能。
- 未激活、但开了「接收全部消息」的群里，不 @ SILI 发 `[[词条]]` 也会展开。
- op 在群里发 `channel.activate` / `激活` 后，该群可用高级功能；`channel.activate -r` 后恢复为未激活。
- 控制台里切换群的激活状态，效果与指令相同。
- bot 被移出群后再拉回来，群是未激活状态。
- 未激活的私聊里 `help`、`dice` 能用，和 SILI 聊天得到「找小鱼君激活」的提示；`user.activate` 之后可以正常聊天。
