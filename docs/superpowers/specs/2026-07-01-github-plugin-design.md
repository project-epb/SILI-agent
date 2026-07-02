# 自研 GitHub 插件 设计

自研替换停更两年的 `koishi-plugin-github@5.5.1`。后者唯一致命 bug：webhook handler 读 `_ctx.request.rawBody` 得 `undefined`（`@koishijs/plugin-server@3.2.x` 底层换 koa-body v6 后，原始字节改挂 `Symbol.for('unparsedBody')`），导致 `createHmac(...).update(undefined)` 抛 `TypeError`，**所有仓库事件推送完全失效**。根因详见 `.debug/github-plugin/root-cause-verified.md`、npm 替代品调研见 `.debug/github-plugin/npm-alternatives.md`（结论：全生态仅原作者 fork 修对，但只是 86 行原语，无高层功能）。

## 原则

- **用户侧 1:1 复刻**旧插件的全部命令与行为（含 star）；**背后实现完全现代化**，允许引入 octokit。
- **数据层与签名层必须保持兼容**：复用同一批 DB 表、同一套 HMAC-SHA256 签名方案、每 webhook 独立 secret、同样的 HTTP 路由。→ 生产 DB 现存订阅 + GitHub 上已注册的 webhook **零重订阅，无缝继续工作**。

## 形态

独立插件 `src/plugins/github/`（目录形态），在 `src/index.ts` 的 `PluginCollectionThirdParty` 里替换原 `ctx.plugin(PluginGithub, {...})` 注册。配置项保持兼容（`path: '/api/github'`、`appId/appSecret` 走 env `TOKEN_GITHUB_APPID/APPSECRET`、`redirect`、`replyTimeout`、`replyFooter`）。

## 复用约束（不可变，否则破坏生产兼容）

| 项 | 值 | 原因 |
|---|---|---|
| `github` 表 | `{ id: integer(webhookId), name: string(50), secret: string(50) }` | 现存 webhook 注册记录 |
| `channel.github.webhooks` | `json`：`{ [repo小写]: 事件过滤meta }` | 现存群订阅 |
| `user.github.accessToken / refreshToken` | `string(50)` | 现存 OAuth token（经典 `gho_` token ≈40 字符可容；保持 50 复用，需要 fine-grained token 再加宽） |
| 签名方案 | HMAC-SHA256 over **raw body**，header `x-hub-signature-256: sha256=<hex>` | GitHub 强制 + 兼容存量 secret |
| secret 生成 | `Random.id()`（koishi） | 与旧一致 |
| webhook content_type | `application/x-www-form-urlencoded`（建 hook 时不设 content_type，GitHub 默认值）→ raw body 形如 `payload=%7B...%7D` | 兼容存量 hook；解析走 `body.payload` |
| 路由 | `GET /api/github/authorize`（OAuth 回调）、`POST /api/github/webhook` | GitHub OAuth App 登记的 callback + 存量 hook 的 url 不可变 |

## 技术栈（现代化部分）

- `octokit`（REST + GraphQL）：建/删 webhook、建 issue、star、评论、`github.user` 卡片 GraphQL。**用 bun 安装**（`bun add`，禁用 pnpm）。
- `@octokit/webhooks-methods` 的 `verify(secret, rawBody, signature)`：timing-safe，替代手写 `createHmac`。
- `@octokit/webhooks-types`：payload 类型（已在 lockfile，升级即可）。
- `@octokit/oauth-methods` 的 `exchangeWebFlowCode`：OAuth code→token，不引整套 oauth-app（避免它抢路由）。

## 模块结构

```
src/plugins/github/
├── index.ts        入口：Config schema、model.extend(复用表)、注册子模块、ready 时重建订阅索引
├── service.ts      GitHubService：按 user token 造 octokit 实例、token 存取、db 助手、订阅索引(repo→Set<cid>)
├── webhook.ts      POST /api/github/webhook：unparsedBody 取原始字节 → verify → 派发到订阅 channels
├── oauth.ts        github.authorize 命令 + GET /api/github/authorize 回调 + code 交换
├── events/         事件渲染器，输入 typed payload → 输出 satori JSX 消息
│   ├── index.ts    注册各渲染器 + 事件过滤(按 channel meta)
│   ├── push.tsx  issues.tsx  comment.tsx  review.tsx  fork.tsx  milestone.tsx  star.tsx
├── commands/       repos.ts(建删webhook+订阅) channel.ts(群订阅 github -l/-a/-d) issue.ts star.ts
├── reply.ts        引用回复交互（react / comment / close），history 映射消息→GitHub 资源
├── user-card.tsx   github.user 命令 + html 服务渲染活跃度瓷砖卡片
└── __tests__/      签名校验 golden、渲染快照、订阅过滤单测
```

## Webhook 数据流（核心修复点）

```
GitHub POST /api/github/webhook  (x-www-form-urlencoded)
 1. raw = koa.request.body[Symbol.for('unparsedBody')]      ← ★ bug 修复：拿原始字节
 2. payload = JSON.parse(safeParse(body.payload))            ← 兼容 urlencoded payload 字段
 3. webhookId = +headers['x-github-hook-id']；查 github 表拿 secret
    - 无记录 → 202（与旧语义一致，repos -a 探测期用）
 4. ok = await verify(secret, raw, headers['x-hub-signature-256'])
    - 不过 → 403
 5. event = headers['x-github-event']；fullName = payload.repository.full_name.toLowerCase()
    - repo 改名 → 更新 github 表 + channel.github.webhooks 迁移（复刻旧逻辑）
 6. 查订阅索引 repo→channels；逐 channel 按 meta 过滤事件类型
 7. 渲染 events/<type> → satori JSX → 经既有发送工具推到各群（formatSession 收口）
 8. status = 200
```

错误分层：第 1–4 步核心校验 fail-fast（返回对应状态码 + 日志）；第 7 步渲染/发送 error-boundary，单 channel 或单事件失败不影响其余。

## OAuth 流程（回调路由兼容）

- `github.authorize`（alias `github.auth`）：生成 state 存内存映射 `state→userId`，返回 `https://github.com/login/oauth/authorize?client_id&state&redirect_uri=<config.redirect>&scope=admin:repo_hook,repo`。
- `GET /api/github/authorize`：取 `query.code/state` → `exchangeWebFlowCode` 换 access/refresh token → 存 `user.github.*`。
- 后续建 webhook / issue / star / 评论用该 user 的 token 实例化 octokit。

## 命令面（用户侧 1:1）

| 命令 | 行为（复刻旧） |
|---|---|
| `github.authorize` / `.auth` | 返回 OAuth 授权链接，回调后存 token |
| `github [name]` / `gh` | 群级订阅。`-l` 列出本群订阅；`-a <repo>`(authority 2) 订阅（webhook 未注册则提示走 repos）；`-d <repo>`(authority 2) 取消 |
| `github.repos [name]` | 用户级 webhook 注册。`-a` 经 octokit 在仓库建 webhook（需 auth，scope admin:repo_hook）；`-d` 删；`-s` 同时订阅当前群 |
| `github.issue [title] [body] -r <repo>` | 建 issue（需 auth） |
| `github.star [name]` | star 仓库（需 auth；PUT /user/starred/{repo}） |
| **引用回复交互** | 引用一条推送消息后：`react` 加 emoji（+1/-1/laugh/confused/heart/hooray/rocket/eyes 8 种）、评论回复、close（关 issue/PR，可带评论）。靠 `history` 映射消息 id → GitHub 资源 url，`replyTimeout` 内有效 |
| `github.user <name>` | **新增**，见下节。非阻塞优先级 |

## 事件渲染器（用户侧 1:1）

复刻旧 `events.js` **全部**渲染（按 `x-github-event` 分派，单个渲染器内部 `switch(payload.action)`）：

| event | 覆盖的 action / 说明 |
|---|---|
| `push` | 非 bot、跳过建删分支（Phase 1 已做） |
| `issues` | opened / closed / reopened / transferred |
| `issue_comment` | created / edited / deleted |
| `commit_comment` | created / edited / deleted |
| `pull_request_review_comment` | created / edited / deleted |
| `pull_request_review` | submitted（有 body 才发） |
| `pull_request` | opened / closed(含 merged) / reopened / review_requested / converted_to_draft / ready_for_review |
| `create` / `delete` | 建 / 删 分支·标签 |
| `fork` | — |
| `milestone` | opened / closed |
| `star` | created |

- 每渲染器**纯函数** `(payload) => Fragment | null`，返回 `null` 跳过（bot 发起 / 无 body / 无关 action）。内容信息量与旧一致（作者/名称/标题/摘要）。**交互对象（link/react/reply/close…）属 Phase 4，Phase 2 渲染器只产出消息文本。**
- **正文（issue/PR/comment body）纯文本转发**：不引 `koishi-plugin-markdown`、不做 md 渲染；仅 `cleanBody()` 去掉 `<!-- BOT-MESSAGE-FOOTER -->` 及其后内容、剥离独立 HTML 注释行、合并空行、trim。**超长按 `bodyMaxLength`（config，默认 500）截断加省略号**。
- 每渲染器快照测试。

## `github.user` 卡片（新增，低优先）

`github.user <login>` → `octokit.graphql` 查 `user.contributionsCollection.contributionCalendar`（weeks→days，每天 `contributionCount` + `color`）+ 基础 profile（头像/名字/bio/followers）→ `ctx.html` 渲染带**活跃度瓷砖**（GitHub 风格 contribution graph）的卡片图。数据走**官方 GraphQL**（认证用 bot 或调用者 token），不抓主页 SVG、不靠第三方 API。`inject: ['html', 'puppeteer']`，缺失则降级文本。

## 测试

- **签名校验 golden**：构造真实 urlencoded raw body + 已知 secret，用 GitHub 文档算法算出 `sha256=` signature，断言 `verify` 通过；篡改 body/secret 断言失败。覆盖修复点。
- **渲染快照**：各事件渲染器对样本 payload 的 JSX 输出快照。
- **订阅过滤单测**：channel meta 过滤逻辑（订阅了哪些事件类型）纯函数化后单测。
- 测试置于 `src/plugins/github/__tests__/`。

## 迁移 / 上线

- 替换 `src/index.ts` 注册；DB 表名/结构不变 → 无 migration、无重订阅。
- GitHub OAuth App 配置（callback url、client id/secret）不变。
- 存量 webhook 的 url（`/api/github/webhook`）+ secret 不变 → 立即恢复推送。

## 不做 / 暂缓

- 不改 DB schema（除非 token 长度被证实溢出）。
- 不引整套 `@octokit/oauth-app`（只用 oauth-methods 做 code 交换）。
- `github.user` 卡片视实现成本可拆为后续 plan，不阻塞主体修复上线。
