# 自研 GitHub 插件 Phase 4 设计：引用回复交互 + issue/star 命令

Phase 3（OAuth + 订阅命令 + 改名迁移）已在生产运行。Phase 4 补齐旧 `koishi-plugin-github` 剩下的用户侧功能：**引用回复交互**（quote 一条推送消息触发 GitHub 操作）、**`github.issue` / `github.star` 命令**，并在引用回复上做两处「做得更好」的增强。

## 目标

- 用户绑定 GitHub 后，sili 在群里推了一条事件通知，`replyTimeout` 窗口内 quote 这条消息 → 直接对对应 GitHub 资源执行操作（评论 / reaction / 关闭 / 合并 / 回显链接 / 帮助）。
- 复刻旧插件除 `.shot` 外的全部临时指令，新增 `.help`。
- `github.issue`、`github.star` 两条独立命令。
- 两个增强：引用回复正文去噪、评论自动带上被引用原文的 markdown 引用上下文。
  - 后续调整：引用上下文**仅 `.reply` 显式触发**；直接打字是 bare 评论（在 issue 里表态，非回复某人），`.close`/`.merge` 的意见同理不引用（针对主对话）。

## 范围

**临时指令（引用推送消息后触发）——共 9 个：**

| 指令 | 作用 | 适用事件 |
|---|---|---|
| `.reply <文本>` | **引用**原消息并评论（`> 原文` + 文本） | issue / PR / 各类 comment |
| 直接打字（无前缀默认） | **不引用**，直接在 issue 里发表评论（表个态，非回复某人） | 同上 |
| `.react <emoji>` | 加 reaction（**无前缀默认**：8 种 emoji 名即 react） | issue / PR / comment |
| `.link` | 回显事件链接 | 几乎所有事件 |
| `.close [文本]` | 关闭 issue/PR，可带一句评论 | issues / pull_request |
| `.base <分支>` | 改 PR 的 base 分支 | pull_request |
| `.merge [标题]` | merge 合并 PR | pull_request |
| `.rebase [标题]` | rebase 合并 PR | pull_request |
| `.squash [标题]` | squash 合并 PR | pull_request |
| `.help` | **新增**：列当前这条消息支持的指令（动态） | 任意命中 history 的消息 |

**命令：** `github.issue [title] [body] -r <repo>`（建 issue）、`github.star [name]`（star 仓库）。

**不做：** `.shot`（puppeteer 截图，见「暂缓」）。

**8 种 reaction emoji：** `+1` `-1` `laugh` `confused` `heart` `hooray` `rocket` `eyes`。

## 架构决策：方案 B（独立 actions 层）

reply 交互需要「引用的这条消息 → 对应哪个 GitHub 资源 url」的映射。旧插件由渲染器同时返回 `[消息, 动作map]`；Phase 2 的渲染器只返回消息。

**采用方案 B：新增独立的 `actions.ts`，`buildActions(event, payload) → ActionMap`，Phase 2 渲染器零改动。** webhook 广播后 `history[msgId] = buildActions(event, payload)`。理由：Phase 2 刚在生产验证通过，不去动它；reply 作为纯叠加层，回归风险最低。

**Phase 2 真·零改动：** 原以为需要给 `cleanBody` 加 INDICATOR 截断，核对后发现 `events/util.ts` 的 `cleanBody` **已经**做了（`indexOf(INDICATOR)` → `slice`，util.ts:11-12）。bot 代发评论被推回群时 footer 早已被截掉，Phase 2 渲染器完全不用动。

## 模块结构

```
src/plugins/github/
├── actions.ts       新增：buildActions(event, payload) → ActionMap；ActionMap 类型
├── reply.ts         新增：ReplyHandler（各动作执行）+ parseReplyCommand + formatHelp + buildQuotedComment（纯函数）
├── history.ts       新增：内存 history map（msgId → ActionMap）+ replyTimeout 清理封装
├── commands.ts      扩展：github.issue / github.star 两条命令
├── http.ts          扩展：GitHubHttp 加通用 authed request(user, method, url, body?, headers?)
│  (events/util.ts   无需改：cleanBody 已支持 INDICATOR 截断，util.ts:11-12)
├── index.ts         接线：广播后写 history、注册 before('attach-user') + reply middleware
└── __tests__/       actions / parseReplyCommand / buildQuotedComment / formatHelp / INDICATOR / ReplyHandler
```

## 动作映射（buildActions）

`ActionMap` 是 `Partial<Record<ActionName, any[]>>`，value 是传给 `ReplyHandler[name]` 的参数数组。`ActionName = 'link'|'react'|'reply'|'close'|'base'|'merge'|'rebase'|'squash'`（`help` 是元指令，不入 ActionMap）。

| 事件 (x-github-event / action) | ActionMap |
|---|---|
| `issue_comment` | `{ close:[issue.url, comments_url], link:[html_url], react:[comment.url+'/reactions'], reply:[comments_url] }` |
| `commit_comment` | `{ link:[html_url], react:[comment.url+'/reactions'], reply:[`…/commits/${commit_id}/comments`, {path, position}] }` |
| `pull_request_review_comment` | `{ close:[pr.issue_url, pr.comments_url], link:[html_url], react:[comment.url+'/reactions'], reply:[`…/pulls/${number}/comments/${id}/replies`] }` |
| `issues/*` (opened/closed/reopened/transferred) | `{ close:[issue.url, comments_url], link:[html_url], react:[issue.url+'/reactions'], reply:[comments_url] }` |
| `pull_request/*` | `{ base:[pr.url], close:[issue_url, comments_url], link:[html_url], merge:[pr.url+'/merge'], rebase:[pr.url+'/merge'], squash:[pr.url+'/merge'], react:[issue_url+'/reactions'], reply:[comments_url] }` |
| `pull_request_review/submitted` | `{ link:[html_url], reply:[comments_url] }` |
| `push` | `{ link:[compare] }` |
| `star` / `fork` / `milestone` / `create` / `delete` | `{}`（无交互） |

来源逐字对应旧 `events.js` 的 `onComment`/`onIssue`/`onPullRequest`/各 handler，砍掉 `shot`、保留 `base/merge/rebase/squash`。`buildActions` 是纯函数（payload → ActionMap），可单测。

> 增强（偏离旧插件）：`issue_comment` / `pull_request_review_comment` 额外提供 `close`——评论挂在可关闭的 issue/PR 上，payload 自带 `issue.url`(或 `pull_request.issue_url`) + `comments_url`，从评论通知直接关闭很自然。此外，对已跟踪的 github 推送用了**该消息类型不支持的显式 `.命令`** 时，回一句「不支持 + 可用列表」而非静默落到 chat。

## 触发解析规则（parseReplyCommand，纯函数）

输入 `body = session.stripped.content.trim()`（已验证 NapCat 下干净：适配器移除 quote 元素、`stripped` 剥掉开头 at bot）。

```
1. /^[.!\/]?help$/i.test(body)  → { name: 'help' }              // .help / help / !help / /help
2. body.startsWith('.')          → name = body.slice(1) 的第一个词；message = 其余
3. 否则                          → name = REACTIONS.includes(body) ? 'react' : 'reply'; message = body
```

- **help 优先判**（`.help` 也匹配 regex），精确匹配整串，不误伤「help我看看」这类评论。
- 硬编码 `.` 前缀（不用真实命令前缀 `!`）：reply middleware 在命令系统之前拦截，用 `!` 会与命令解析边界纠缠、且 `stripped.prefix` 在拦截时点尚未填充。`.` 绕开整个命令系统。

## history 生命周期

- 内存 `Record<messageId, ActionMap>`（`Object.create(null)`）。
- **写入**：`ctx.broadcast(targets, msg)` 返回各频道 messageIds → 每个 `history[id] = actions`。仅当 `actions` 非空才写（无交互事件不占用）。
- **清理**：`ctx.setTimeout(() => messageIds.forEach(id => delete history[id]), config.replyTimeout)`（默认 1h，复用现有 Config）。
- 进程重启丢失（可接受，1:1 旧插件）。

## reply middleware 分发

```
ctx.before('attach-user', (session, fields) => {          // 命中 history 才拉 github token 字段
  if (session.quote && history[session.quote.id]) fields.add('github')
})

ctx.middleware((session, next) => {
  if (!session.quote) return next()
  const actions = history[session.quote.id]
  if (!actions) return next()
  const { name, message } = parseReplyCommand(session.stripped.content.trim())
  if (name === 'help') return formatHelp(Object.keys(actions))    // 元指令，列 keys
  const params = actions[name]
  if (!params) return next()                                       // 该事件不支持此动作
  return new ReplyHandler(ctx, http, session, message)[name](...params)
})
```

`formatHelp(keys)`（纯函数）：把 keys 映射成中文说明列表，并附无前缀提示（「直接发 emoji 即点赞，直接打字即评论」）。

## ReplyHandler 动作实现

构造 `(ctx, http, session, content)`；`content` = 用户回复正文（增强1）。所有网络动作走 `http.request(user, method, url, body?, headers?)`，失败时 `logger.warn` + 返回带 `describeHttpError` 细节的提示（遵循 [[prefer-specific-error-messages]]，不用笼统「操作失败」）。

| 方法 | 实现 |
|---|---|
| `link(url)` | 直接返回 url（回显，无网络） |
| `react(url)` | 校验 `content ∈ REACTIONS`；POST `url` body `{content}`，header `accept: application/vnd.github.squirrel-girl-preview` |
| `reply(url, params?)` | POST `url` body `{ body: buildQuotedComment(...), ...params }`（`params` 承载 commit_comment 的 `{path, position}`） |
| `close(url, commentUrl)` | 若 `content` 非空先 `reply(commentUrl)`；再 PATCH `url` body `{state:'closed'}` |
| `base(url)` | PATCH `url` body `{ base: content }` |
| `merge(url, method='merge')` | content 首行=commit_title、其余=commit_message；PUT `url` body `{ merge_method, commit_title, commit_message }` |
| `rebase(url)` | `merge(url, 'rebase')` |
| `squash(url)` | `merge(url, 'squash')` |

## 两个增强（纯函数）

**增强1 — 干净回复正文：** 直接用 `session.stripped.content`。NapCat OneBot 适配器把引用段 shift 进 `session.quote`（`koishi-plugin-adapter-onebot` index.js:342），koishi `stripped` 剥掉开头 at bot（`@koishijs/core` index.cjs:1816）。其他平台若残留 quote 元素，`ReplyHandler` 构造前做一次 element-level 兜底 strip。

**增强2 — 评论带引用上下文：** `buildQuotedComment(quotedText, userReply, footer)`：
1. `quotedText` = `session.quote.content` 去掉 `config.messagePrefix`（`[GitHub] `）前缀。
2. 逐行加 `> ` 前缀 → 空行 → `userReply` → `\n\n` + INDICATOR + `\n` + footer。
3. 「多层嵌套」自动累加：原文已有 `>` 的行加前缀后变 `> >`，层级天然叠加。
4. `quotedText` 为空时退化为「纯 userReply + INDICATOR + footer」。

## INDICATOR 防噪（footer 截断）

`INDICATOR = '<!-- BOT-MESSAGE-FOOTER -->'`（沿用旧插件常量值，保证与存量 bot 评论兼容）。

- **发送**：`buildQuotedComment` 在正文与 footer 之间插入 INDICATOR（见增强2 步骤2）。
- **渲染**：bot 代发的评论会作为 `issue_comment(created)` 事件被推回群一次。`events/util.ts` 的 `cleanBody` **已经**在 `body` 含 INDICATOR 时截断到之前（util.ts:11-12），推回的消息自动不带重复 footer，无需改动。回环只有一跳（无限循环不存在），维持 1:1 行为（推送 + 截 footer），不额外做「跳过推送」。

## github.issue / github.star 命令

1:1 旧 `command.js`：
- `github.issue [title] [body:text]` `-r [repo]`：校验 repo 格式 + 需 auth；POST `/repos/{repo}/issues` `{title, body}`。成功回执 + 失败带 `describeHttpError`。
- `github.star [name]`：校验 + 需 auth；PUT `/user/starred/{name}`。
- 未授权时复用现有「请先授权 → `github.authorize`」流程。

## GitHubHttp 通用 request

新增 public `request<T>(user, method, url, body?, headers?): Promise<T>`，内部复用现有 private `withAuth`（401 自动 refresh + 持久化）。`ReplyHandler` 各动作、`github.issue`、`github.star` 全部走它。`authHeaders(token)` 已存在。

## 复用约束（不可变）

- Phase 2 渲染器逻辑不动（除 `cleanBody` 的 INDICATOR 截断一行）。
- history 内存 + `replyTimeout`，不建表。
- 签名 / 路由 / DB schema 全不变。
- bun only；注释英文；纯函数单测，命令/middleware glue 由 tsc + 真机验证。

## 测试策略

- **纯函数单测**：`buildActions`（各事件样本 payload → ActionMap）、`parseReplyCommand`（help/`.`前缀/emoji/默认 reply 各分支）、`buildQuotedComment`（含多层嵌套、空 quotedText、INDICATOR 位置）、`formatHelp`（keys → 文本）、`cleanBody` INDICATOR 截断。
- **ReplyHandler**：mock `http.request`，断言各动作的 method/url/body/header（尤其 react 的 squirrel-girl header、merge 的 title/message 拆分、close 的先评论后 PATCH）。
- **glue（tsc + 生产真机）**：reply middleware 引用检测与分发、`before('attach-user')` 补字段、广播后写 history、issue/star 命令。
- 测试置于 `src/plugins/github/__tests__/`，沿用 `vi.mock('koishi', …)` stub 规避 loader 副作用。

## 不做 / 暂缓

- **`.shot`**：puppeteer 截 GitHub 页面。依赖 puppeteer 服务 + 公网访问 github.com + 硬编码 anchor selector，脆弱且增量有限（推送消息已含评论正文）。未来若做，单独一个 plan。
- **`githubProxy` / `githubApiProxy` 可选配置**（backlog）：国内服务器（生产阿里云杭州）访问 github.com 存在网络抖动 —— Phase 3 的 OAuth token 交换就曾 `fetch failed`。一个可选的出站代理配置能一并改善 OAuth / REST / 未来 `.shot` 的连通性。非本期范围，记录待评估。
- **跳过 bot 自发评论的回推**（backlog）：用户通过快捷指令代发的评论会作为 `issue_comment(created)` 事件被推回群一次，略吵。本期维持 1:1（推 + INDICATOR 截 footer），与旧插件一致不处理。未来可选优化：webhook 渲染层检测评论 body 含 INDICATOR → 直接跳过该条推送。
