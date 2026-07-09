# LLM 用户管理控制台 — 设计文档

## 目标

给 SILI 的 LLM 插件提供一个**按用户**的管理控制台（koishi console 页面）：搜索用户 → 查看该用户的用量总览、会话历史（chat 式回放）→ **管理其长期记忆**（改 / 清空）、**强制轮转其 session**。

读侧已由原型 spike 验证（commit `94cdae7`）；本 spec 固化为带测试的正式实现，并补上分页、N+1 修复、写操作。

## 非目标（YAGNI）

- 不做跨用户批量操作、不做用户封禁/权限编辑。
- 不渲染 system prompt——它请求时从进程内 memoize 的共享 builder 实时拼接、**不落库**，跨用户共享，无「这个用户这段对话」的信息。
- 不做实时推送；打开时拉取 + 手动刷新 / 加载更多。
- 不引入前端构建工具链。

## 架构

独立 workspace 子包 `plugins/llm-admin/`（`koishi-plugin-llm-admin`，未来可独立发包）：

```
plugins/llm-admin/
├── package.json          # name: koishi-plugin-llm-admin
├── index.ts              # 后端：listener 注册 + addEntry
├── aggregate-user.ts     # 纯函数：单用户用量聚合（可单测）
├── client/
│   ├── index.js          # 手写 ESM：vue-router 路由 + Vue h() 渲染
│   └── style.css
└── __tests__/aggregate-user.test.ts
```

- `inject: ['console', 'database', 'llm']`。后端 TS 由 bun 直接跑、**不构建**；前端手写浏览器 ESM，console 原样 serve。
- 复用仪表盘验证过的机制：伪包（`../vue.js` / `../client.js` / `../vue-router.js`）、`resolveComponent('k-layout'/'k-card')`、鉴权就绪门（首个 `send` 等 `store.user`）、`addEntry` 指向 `node_modules/koishi-plugin-llm-admin/client`（过 403 守卫）。
- 已在 `src/index.ts` 的 console 注册块 `ctx.plugin(PluginLlmAdmin)`；生产 `docker-compose.yml` 的 `./plugins` 挂载已就位。

## 权限与隐私（一等约束）

- **authority 4（仅 sysop）** 门控**页面 + 全部 listener（含读）**。记忆/会话正文是隐私数据，读也要拦。（plugin-auth 的 `on("activity", n => n.authority>0 && user.authority<n.authority)` 钩子对 <4 用户隐藏侧栏入口 + router 拦导航；listener 的 `{ authority: 4 }` 拒绝数据请求。）
- **服务端日志不落记忆/会话正文**，只记 id / 计数。
- **破坏性写操作（清空记忆、强制轮转）UI 内二次确认**再发请求。
- 会话回放**默认只拉最近 N 轮**（N=20），显式「加载更早」再往前——避免整段隐私历史一次性倾倒。
- 前端不做持久化/缓存；数据按需拉取、只流向已鉴权的 sysop 会话。页面顶部常驻隐私提示条。

## 数据模型（已查实）

一切围绕 **koishi `user.id`** 对齐，选中用户后无需 binding 解析即可取其全部数据：

| 概念 | 表 | 键 |
|---|---|---|
| 长期记忆 | `openai_user_memory` | `(platform, user_id)`，其中 `user_id = String(koishi user.id)`，`platform` 归一化（`onebot → 'qq'`） |
| 会话 | `openai_session` | `conversation_id`；按 `conversation_owner`(= user.id) 查该用户所有会话 |
| 消息历史 | `openai_chat` | 按 `conversation_id` 查，排序 **`(turn_number, intra_turn_seq, id)`**（`time` 是 wall-clock、不单调，不作排序键） |

- `resolveMemoryKey(session)`：`platform = onebot?'qq':platform`，`userId = String(session.user.id)`。→ 后端无 session，按 `user_id = String(选中id)` 直接查记忆行；写时 platform 取现有行的 `platform`（无现有行则取该用户首个 binding 的 platform 归一化）。
- user 行的 `content` 是完整 envelope（`<long_term_memory>?` + `<turn_context>` JSON + `<user_message>`）。回放时抽取 `<user_message>` 内层为正文，完整 envelope 放折叠。
- token 聚合陷阱：`cachedTokens ⊂ promptTokens`、`reasoningTokens ⊂ completionTokens`，不重复计入 total；缺失 `?? 0`；`totalTokens` 缺省回退 `prompt+completion`。

## 服务（`ctx.llm.*`）复用

| 操作 | 复用 |
|---|---|
| 改记忆 | `ctx.llm.memory.getMeta(p,u)` 读；`ctx.llm.memory.set(p,u,content,msgCount,convId)` 写（`msgCount`/`convId` 传现有 meta 的 `message_count_at_update`/`last_forked_conversation_id` 以保留 fork 节流状态） |
| 清空记忆 | `ctx.llm.memory.delete(p,u)` |
| 会话历史 | 直接查 `openai_chat`（需要 reasoning/tool_calls/time 等字段，`chatHistory.getById` 的 turn 限制语义不完全匹配预览需求） |
| 强制轮转 | `crypto.randomUUID()` + `ctx.llm.sessions.create({conversationId,conversationOwner,platform,userId,userFirstMsg:'(强制轮转)'})` + 置 `user.openai_last_conversation_id` + 同步 `ctx.llm.activeChats`（若有在飞缓存）。**纯新开、不压缩、不带 prev_session_id。** |

## 后端 API（listener，全部 `authority: 4`）

```ts
'llm-admin/search'(payload: { q: string; limit?: number; offset?: number })
  : { total: number; users: AdminUser[] }                 // #id 精确 / platform:pid 子串 / 昵称子串
'llm-admin/overview'(payload: { id: number }): UserOverview | null   // 用量卡片 + 近30天趋势 + 模型分布 + 会话总数
'llm-admin/sessions'(payload: { id: number; limit?: number; offset?: number })
  : { total: number; rows: SessionRow[] }                 // 按 last_used_at 倒序；标当前活跃 / 压缩派生 / 轮数
'llm-admin/session'(payload: { conversationId: string; limit?: number; beforeTurn?: number })
  : { messages: ChatMsg[]; earliestTurn: number; hasMore: boolean }   // 最近 N 轮 + 加载更早
'llm-admin/memory-get'(payload: { id: number }): { content: string; byteSize: number; updateCount: number; lastUpdated: number|null; platform: string|null }  // 读，供编辑器载入
'llm-admin/memory-save'(payload: { id: number; content: string }): { ok: boolean; byteSize: number; error?: string }  // 写
'llm-admin/memory-clear'(payload: { id: number }): { ok: boolean }                                  // 写
'llm-admin/rotate'(payload: { id: number }): { ok: true; conversationId: string }                   // 写
```

`AdminUser = { id, name, account }`；`SessionRow = { conversationId, title, startedAt, lastUsedAt, isCurrent, isCompacted, turns }`；`UserOverview`、`ChatMsg` 见原型 `index.ts`（`ChatMsg` 含 `time`、user 带 `raw` envelope、assistant 带 `reasoning`/`toolCalls`、tool 带 `toolName`）。

### 分页 & 性能

- **search**：候选池（有过会话的用户）解析身份后过滤，`limit`(默认 50)/`offset` 切片 + `total`。
- **sessions**：`limit`(默认 30)/`offset` + `total`；**修 N+1**——原型为每个会话单查一次轮数，改为只对当前页窗口查、或一次性按 `conversation_id ∈ 当前页` 批量查 `turn_number` 再分组。
- **session**：按 `turn_number` 倒序取最近 `limit`(默认 20) 轮的行、再正序展示；`beforeTurn` 游标往前加载更早；返回 `hasMore` / `earliestTurn`。前端是**聊天软件式无限上滚**（见 UX），非按钮。

## 前端 UX（vue-router query 路由，已由原型验证）

单注册页 `/llm-admin`（`authority: 4`），用 `useRoute`/`useRouter` 的 query 做真实路由（`?user=<id>&session=<convId>`，可深链 / 后退）：

- **无 user**：搜索视图（隐私提示条 + 表单 + 结果列表，点结果 `push({query:{user}})`）。
- **有 user**：master-detail
  - **左栏**：固定用户头（昵称 + platform:pid + #id，会话数 · 总 tok；**点击回总览**，即 drop session query；区内含「强制轮转 ⚠」按钮）+ 「返回搜索」+ **会话列表**（倒序、标题=首句、最后活跃 + 轮数、当前/压缩 badge、「加载更多」）。
  - **右栏 · 无 session（总览视图）**：用量卡片（含输入/输出/缓存）+ 近30天趋势 SVG + 模型分布 + **记忆编辑器卡片**。
  - **右栏 · 有 session**：**chat 式回放（聊天软件式）**——用户气泡右 / SILI 气泡左 / 工具紧凑折叠；**默认折叠**：`💭 思维链`、`🔧 调用 <工具名>`、`🔧 <工具名> 结果`、`📄 原始 envelope`；每气泡下小号日期。**打开定位到底部（最新）**，**向上滚动到近顶部自动加载更早**（prepend + 保持滚动位置，无限上滚），`hasMore=false` 停。
- **记忆编辑器卡片**（右栏总览内）：textarea 载入现有记忆 + 字节计数（对 `memoryByteLimit`，默认 3000，超限拦保存）+ 「保存」+「清空 ⚠」（二次确认）。
- **强制轮转**：左栏用户头区「强制轮转 ⚠」按钮，二次确认后 `rotate`，成功刷新会话列表。

## 测试

- **纯函数单测**（`aggregate-user.ts` 抽出原型内联的聚合）：单用户 token 数学（in/out/cached 不重复计）、近30天趋势按天分桶、模型分布排序。
- 搜索三路匹配（#id / pid / name）、分页切片（limit/offset/total）、会话回放 turn 窗口切分、记忆 platform 键归一化（`onebot→qq`）——可测的纯逻辑抽出单测。
- listener 薄封装 + 写操作：浏览器实机验证（真实数据）；写操作在**测试用户**上验证真实落库 + 二次确认流程。

## 部署

- 无构建：手写 ESM 直接 serve，`git pull` + restart 生效。
- workspace 成员进 `bun.lock`，容器 `bun install --frozen-lockfile` 建 symlink。首次部署走 `docker compose up -d core`（`./plugins` 挂载已在 compose 中）。

## 已决

- 位置：**独立包** `plugins/llm-admin`。入口：仪表盘 TOP 用户可跳 + 本页搜索。
- 权限：**authority 4 仅 sysop**，读也拦。
- 轮转语义：**纯新开**（丢上下文，不压缩）。
- session 预览：**会话列表 + 点任意一条回放**。
- 路由：**vue-router query 真实路由**（非内存态）。
- 分页：sessions/search 用 limit/offset+total；replay 最近 N 轮 + 加载更早；修 sessions N+1。
