# LLM 用量仪表盘 — 设计文档

## 目标

给 SILI 的 LLM 插件提供一个 web 仪表盘，展示最近的 AI 聊天用量：总览、用量趋势、各模型消耗、各用户消耗排行。挂在 koishi console（`/dash`）侧边栏，复用 console 登录鉴权。

## 非目标（YAGNI）

- **不做金额成本估算**：只展示 token 数，不维护各模型单价表。
- 不做配额管理、限额告警、自动扣费。
- 不做实时推送：统计类数据打开时拉取 + 手动刷新即可。
- 不引入前端构建工具链（vite/SFC/@koishijs/client 构建）。

## 架构

独立 workspace 子包 `plugins/koishi-plugin-llm-dashboard`（目录 `plugins/llm-dashboard/`）：

```
plugins/llm-dashboard/
├── package.json          # name: koishi-plugin-llm-dashboard，workspace 成员
├── index.ts              # 后端：DataService 聚合 + addListener 查询 + addEntry 注册
├── client/
│   ├── index.js          # 手写 ESM entry：ctx.page 注册 + Vue h() 渲染
│   └── style.css         # 手写样式（console 检测到会一并 serve）
└── (无 dist —— 不构建)
```

- 根 `package.json` 的 `workspaces` 含 `plugins/*`；`bun install` 在 `node_modules/koishi-plugin-llm-dashboard` 建 symlink。
- 主应用 `src/index.ts` 里 `import * as PluginLlmDashboard from 'koishi-plugin-llm-dashboard'`，在 console 注册块内 `ctx.plugin(PluginLlmDashboard)`。
- 后端是 TS，由 bun 直接跑，**不构建**。前端是手写浏览器 ESM，由 console 原样 serve。

### 关键约束：entry 必须经 node_modules 提供（spike 验证）

`@koishijs/plugin-console` 的 `serveAssets` 守卫：只 serve **解析后路径含 `node_modules`**（或在 console 自身 dist 根下）的 entry 文件，否则 403。因此：

- 插件必须是 workspace 包，`addEntry` 指向 `resolve(ctx.baseDir, 'node_modules/koishi-plugin-llm-dashboard/client')`（经 symlink 解析到真实文件，且路径字符串含 `node_modules`）。
- 不能用 `import.meta.dirname`（解析到真实 `plugins/` 路径，不含 node_modules → 403）。

### 伪包机制（spike 验证）

console 在 uiPath 根提供 `vue.js` / `client.js` / `vue-router.js` / `vueuse.js`（单一共享 Vue 实例 + `@koishijs/client` 运行时）。entry 被 serve 在 `/dash/@plugin-<key>/index.js`，用 `../vue.js` / `../client.js` 引用它们。手写 entry 直接 `import { defineComponent, h, ref, resolveComponent } from '../vue.js'` 和 `import { send } from '../client.js'`。

## 数据层

数据源：`openai_chat` 表（`src/plugins/llm/index.tsx`），已持久化，无需新埋点。相关字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `role` | string | 只有 `'assistant'` 行带 usage |
| `usage` | json | `{ promptTokens?, completionTokens?, totalTokens?, cachedTokens?, reasoningTokens? }` |
| `model` | string | 模型名 |
| `conversation_owner` | integer | koishi user.id |
| `conversation_id` | string | 会话分组 |
| `time` | integer | wall-clock ms |

**聚合策略：JS 内存聚合，不写驱动相关聚合查询。** DB 是 MongoDB；按时间窗口投影出需要的字段拉到内存，用 JS 聚合。驱动无关、robust，聊天机器人这点数据量（数千行）足够；量真大再优化。

```ts
const since = Date.now() - rangeDays * 86400_000
const rows = await ctx.database.get(
  'openai_chat',
  { role: 'assistant', time: { $gte: since } },
  ['time', 'model', 'conversation_owner', 'usage', 'conversation_id']
)
```

**usage 聚合陷阱**（见 `src/plugins/llm/CLAUDE.md`）：`cachedTokens` 已含在 `promptTokens` 内、`reasoningTokens` 已含在 `completionTokens` 内，别重复相加；各字段可能 undefined，用 `?? 0`。

### 用户名补全

`conversation_owner` 是 koishi user.id（数字）。TOP 用户榜尽力补展示名：查 koishi `user` 表（`ctx.database.get('user', { id: [...] }, ['id', 'name'])`）拿 `name`；缺失则回退显示 `#<id>`。

## 后端 API 契约

用 `send()` 请求-响应（带参数的按需查询，贴合切范围/刷新交互），不用被动 DataService store。

```ts
declare module '@koishijs/console' {
  interface Events {
    'llm-dashboard/stats'(payload: { range: 7 | 30 | 90 }): DashboardStats
  }
}
```

`DashboardStats`（一次查询返回四个面板所需的全部聚合结果）：

```ts
interface DashboardStats {
  range: number
  overview: {
    calls: number            // assistant 行数
    totalTokens: number
    promptTokens: number
    completionTokens: number
    activeUsers: number      // distinct conversation_owner
    conversations: number    // distinct conversation_id
    // 环比：与上一个等长窗口比较
    prev: { calls: number; totalTokens: number; activeUsers: number; conversations: number }
  }
  trend: Array<{ date: string; promptTokens: number; completionTokens: number; calls: number }>  // 按天
  models: Array<{ model: string; calls: number; totalTokens: number }>       // 降序
  users: Array<{ id: number; name: string; totalTokens: number; conversations: number }>  // 降序，TOP N
}
```

环比需要查两个窗口（当前 + 上一等长窗口），或一次查 2×range 再切分。按天分桶用服务器本地日（`time` → 本地日期字符串）。

前端：`const stats = await send('llm-dashboard/stats', { range })`。

## 面板

时间范围切换器（7 / 30 / 90 天）在页面顶部；切换 = 重新 `send`。右上角手动刷新按钮。

1. **总览卡片**：总调用次数、总 token、活跃用户数、会话数，各带与上一等长窗口的环比（↑/↓ 百分比）。
2. **用量趋势**：按天 token 时间序列，prompt / completion 分层。手绘 SVG 面积/折线图（零依赖）。
3. **各模型排行**：`model` 聚合的调用次数 + token，降序。CSS 横条 + 数值。
4. **TOP 用户排行**：`conversation_owner` 聚合的 token/会话数降序榜（TOP 10），显示补全的用户名。CSS 横条。

## 前端渲染

- Vue `h()` 渲染函数（非 SFC），`ref` 管理 `range` / `loading` / `stats` 响应式。
- `k-layout` / `k-card` 用 `resolveComponent` 取 console 原生组件。
- 趋势图手绘 SVG（`<path>` / `<rect>`）；排行横条用 CSS width 百分比。
- 无外部 CDN（console 有 CSP）；样式放 `client/style.css`。
- `ctx.page({ path: '/llm-dashboard', name: 'LLM 用量', authority: 3, component })`。

## 鉴权

页面 `authority: 3`（对齐 debug 命令门槛）。`addListener` 传 `{ authority: 3 }`。复用 console 登录，无需自建鉴权。

## 部署

- **无构建步骤**：手写 ESM 直接 serve，`git pull` + restart 即生效。
- **生产 docker 需加 `./plugins:/app/plugins` 挂载**（本地已在 gitignored 的 `docker-compose.override.yml` 里加了；生产的 `docker-compose.yml` 需同步加一条）。这是 plan 要处理的部署项。
- workspace 成员进了 `bun.lock`；容器 `bun install --frozen-lockfile` 会在容器内建 symlink。

## 已知待清理项

- 后端 `Events` 类型增强当前没合并上（addListener 报 `'ping'` 类型错），运行时正常。真实实现时修对 `declare module` 目标 / 结构。
- spike 的 hello-world entry（`client/index.js`）与 `llm-dashboard/ping` listener 由真实实现替换。
- `src/index.ts` 里 `koishi-plugin-llm-dashboard` 的 import 排序位置待归到 `koishi-plugin-` 组（推送前只格式化本次改动文件）。

## 未决 / 已决

- 金额成本：**已决不做**。
- 前端形态：**已决**原生 /dash 页面 + 手写 ESM（spike 验证可行）。
- 位置：**已决** `plugins/llm-dashboard`（workspace 包，未来可独立发包）。
- 正式发包时改用 `bun add koishi-plugin-llm-dashboard@workspace:*` 真链接，替换 spike 的接法。
