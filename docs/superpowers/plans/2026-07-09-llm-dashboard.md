# LLM 用量仪表盘 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 koishi console `/dash` 侧边栏加一个 LLM 用量仪表盘（总览/趋势/模型排行/用户排行），数据来自 `openai_chat` 表。

**Architecture:** workspace 子包 `plugins/llm-dashboard`。后端一个纯函数 `aggregateStats`（单测覆盖）+ 一个 `addListener('llm-dashboard/stats')` 查库聚合返回；前端手写浏览器 ESM（无构建），Vue `h()` 渲染，`send()` 取数。entry 经 `node_modules` symlink 由 console serve。

**Tech Stack:** koishi 4.18 / `@koishijs/console` 5.30 / bun runtime / vitest / 手写 ESM（`../vue.js`、`../client.js` 伪包）。

## Global Constraints

- 运行时是 **bun**；后端 TS 直接跑、**不构建**；前端是手写浏览器 ESM，**不构建**。
- 前端 entry 只能引 `../vue.js` / `../client.js` / `../vue-router.js` / `../vueuse.js`（console 注入的伪包）+ 同目录相对文件。
- `addEntry` 必须指向 `resolve(ctx.baseDir, 'node_modules/koishi-plugin-llm-dashboard/client')`（路径含 `node_modules` 才不会被 console 的 403 守卫拦）。
- `ctx.database.get` 投影语法是 **`{ fields: [...] }`**（不是裸数组）。
- usage 聚合陷阱：`cachedTokens` 已含在 `promptTokens` 内、`reasoningTokens` 已含在 `completionTokens` 内，**不重复相加**；各字段可能 undefined，用 `?? 0`；`totalTokens` 缺失时回退 `prompt + completion`。
- 只展示 token，**不做金额成本**。
- 推送前只格式化本次改动过的文件（项目有 import 排序规则），别整体 `bun run format`。
- 改后端代码后 `docker compose restart core`，约 10s 可测；改前端 `client/*` 同样 restart（无 HMR）。

## 文件结构

```
plugins/llm-dashboard/
├── package.json              # 已存在（spike）
├── index.ts                  # 改：spike ping → 真实 stats listener
├── aggregate.ts              # 新：纯聚合函数 + 类型（单测目标）
├── __tests__/
│   └── aggregate.test.ts     # 新：vitest 单测
└── client/
    ├── index.js              # 改：hello world → 4 面板页面
    └── style.css             # 新：样式
vitest.config.ts              # 改：include 加 plugins/**
docker-compose.yml            # 改：prod 加 ./plugins 挂载（最后一个 task）
```

---

### Task 1: 纯聚合函数 `aggregateStats` + 单测

**Files:**
- Create: `plugins/llm-dashboard/aggregate.ts`
- Create: `plugins/llm-dashboard/__tests__/aggregate.test.ts`
- Modify: `vitest.config.ts`（include 加 `plugins/**/*.test.ts`）

**Interfaces:**
- Produces: `aggregateStats(rows: UsageRow[], rangeDays: number, now: number, nameOf: (id: number) => string): DashboardStats`，及导出类型 `UsageRow` / `ChatUsage` / `DashboardStats` / `OverviewMetrics`。

- [ ] **Step 1: 放开 vitest 扫描范围**

Modify `vitest.config.ts`，把 `include` 改为：

```ts
    include: ['src/**/*.test.ts', 'plugins/**/*.test.ts'],
```

- [ ] **Step 2: 写失败测试**

Create `plugins/llm-dashboard/__tests__/aggregate.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { aggregateStats, type UsageRow } from '../aggregate'

const DAY = 86_400_000
const now = 1_752_000_000_000

function row(partial: Partial<UsageRow> = {}): UsageRow {
  return {
    time: now - DAY,
    model: 'gpt-4o',
    conversation_owner: 1,
    conversation_id: 'c1',
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    ...partial,
  }
}

const nameOf = (id: number) => ({ 1: 'Alice', 2: 'Bob' })[id] ?? `#${id}`

describe('aggregateStats', () => {
  it('aggregates the current-window overview', () => {
    const stats = aggregateStats(
      [
        row({ conversation_owner: 1, conversation_id: 'c1' }),
        row({
          conversation_owner: 2,
          conversation_id: 'c2',
          usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
        }),
      ],
      7,
      now,
      nameOf
    )
    expect(stats.overview.calls).toBe(2)
    expect(stats.overview.totalTokens).toBe(450)
    expect(stats.overview.promptTokens).toBe(300)
    expect(stats.overview.completionTokens).toBe(150)
    expect(stats.overview.activeUsers).toBe(2)
    expect(stats.overview.conversations).toBe(2)
  })

  it('separates the previous equal-length window', () => {
    const stats = aggregateStats(
      [row({ time: now - DAY }), row({ time: now - 9 * DAY })],
      7,
      now,
      nameOf
    )
    expect(stats.overview.calls).toBe(1)
    expect(stats.overview.prev.calls).toBe(1)
  })

  it('ranks models by total tokens descending', () => {
    const stats = aggregateStats(
      [
        row({ model: 'gpt-4o', usage: { totalTokens: 100 } }),
        row({ model: 'claude-sonnet-4-6', usage: { totalTokens: 500 } }),
        row({ model: 'gpt-4o', usage: { totalTokens: 100 } }),
      ],
      7,
      now,
      nameOf
    )
    expect(stats.models[0]).toEqual({ model: 'claude-sonnet-4-6', calls: 1, totalTokens: 500 })
    expect(stats.models[1]).toEqual({ model: 'gpt-4o', calls: 2, totalTokens: 200 })
  })

  it('ranks top users with names and distinct conversation counts', () => {
    const stats = aggregateStats(
      [
        row({ conversation_owner: 1, conversation_id: 'a', usage: { totalTokens: 100 } }),
        row({ conversation_owner: 1, conversation_id: 'b', usage: { totalTokens: 100 } }),
        row({ conversation_owner: 2, conversation_id: 'c', usage: { totalTokens: 50 } }),
      ],
      7,
      now,
      nameOf
    )
    expect(stats.users[0]).toEqual({ id: 1, name: 'Alice', totalTokens: 200, conversations: 2 })
    expect(stats.users[1]).toEqual({ id: 2, name: 'Bob', totalTokens: 50, conversations: 1 })
  })

  it('falls back to total = prompt + completion when totalTokens missing', () => {
    const stats = aggregateStats(
      [row({ usage: { promptTokens: 30, completionTokens: 20 } })],
      7,
      now,
      nameOf
    )
    expect(stats.overview.totalTokens).toBe(50)
  })

  it('handles null usage rows without throwing', () => {
    const stats = aggregateStats([row({ usage: null })], 7, now, nameOf)
    expect(stats.overview.calls).toBe(1)
    expect(stats.overview.totalTokens).toBe(0)
  })

  it('emits a continuous daily trend whose calls sum to the window total', () => {
    const stats = aggregateStats([row({ time: now - DAY })], 7, now, nameOf)
    expect(stats.trend.length).toBeGreaterThanOrEqual(7)
    expect(stats.trend.reduce((s, d) => s + d.calls, 0)).toBe(1)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run plugins/llm-dashboard`
Expected: FAIL —— `Cannot find module '../aggregate'`。

- [ ] **Step 4: 实现 `aggregate.ts`**

Create `plugins/llm-dashboard/aggregate.ts`:

```ts
export interface ChatUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cachedTokens?: number
  reasoningTokens?: number
}

export interface UsageRow {
  time: number
  model: string
  conversation_owner: number
  conversation_id: string
  usage: ChatUsage | null
}

export interface OverviewMetrics {
  calls: number
  totalTokens: number
  promptTokens: number
  completionTokens: number
  activeUsers: number
  conversations: number
}

export interface DashboardStats {
  range: number
  overview: OverviewMetrics & { prev: OverviewMetrics }
  trend: Array<{ date: string; promptTokens: number; completionTokens: number; calls: number }>
  models: Array<{ model: string; calls: number; totalTokens: number }>
  users: Array<{ id: number; name: string; totalTokens: number; conversations: number }>
}

const DAY = 86_400_000

function toLocalDate(time: number): string {
  const d = new Date(time)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

// cachedTokens ⊂ promptTokens, reasoningTokens ⊂ completionTokens — never re-add.
function rowTokens(u: ChatUsage | null) {
  const prompt = u?.promptTokens ?? 0
  const completion = u?.completionTokens ?? 0
  const total = u?.totalTokens ?? prompt + completion
  return { prompt, completion, total }
}

function overviewOf(rows: UsageRow[]): OverviewMetrics {
  let totalTokens = 0
  let promptTokens = 0
  let completionTokens = 0
  const users = new Set<number>()
  const convs = new Set<string>()
  for (const r of rows) {
    const t = rowTokens(r.usage)
    totalTokens += t.total
    promptTokens += t.prompt
    completionTokens += t.completion
    users.add(r.conversation_owner)
    convs.add(r.conversation_id)
  }
  return {
    calls: rows.length,
    totalTokens,
    promptTokens,
    completionTokens,
    activeUsers: users.size,
    conversations: convs.size,
  }
}

export function aggregateStats(
  rows: UsageRow[],
  rangeDays: number,
  now: number,
  nameOf: (id: number) => string
): DashboardStats {
  const windowMs = rangeDays * DAY
  const curStart = now - windowMs
  const prevStart = now - 2 * windowMs

  const current = rows.filter((r) => r.time >= curStart && r.time <= now)
  const previous = rows.filter((r) => r.time >= prevStart && r.time < curStart)

  // trend: bucket current window by local day, fill empty days with zeros
  const byDay = new Map<string, { promptTokens: number; completionTokens: number; calls: number }>()
  for (const r of current) {
    const key = toLocalDate(r.time)
    const b = byDay.get(key) ?? { promptTokens: 0, completionTokens: 0, calls: 0 }
    const t = rowTokens(r.usage)
    b.promptTokens += t.prompt
    b.completionTokens += t.completion
    b.calls += 1
    byDay.set(key, b)
  }
  const trend: DashboardStats['trend'] = []
  const seen = new Set<string>()
  for (let d = curStart; d <= now; d += DAY) {
    const key = toLocalDate(d)
    if (seen.has(key)) continue
    seen.add(key)
    trend.push({ date: key, ...(byDay.get(key) ?? { promptTokens: 0, completionTokens: 0, calls: 0 }) })
  }

  const byModel = new Map<string, { calls: number; totalTokens: number }>()
  for (const r of current) {
    const m = byModel.get(r.model) ?? { calls: 0, totalTokens: 0 }
    m.calls += 1
    m.totalTokens += rowTokens(r.usage).total
    byModel.set(r.model, m)
  }
  const models = [...byModel.entries()]
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.totalTokens - a.totalTokens)

  const byUser = new Map<number, { totalTokens: number; convs: Set<string> }>()
  for (const r of current) {
    const u = byUser.get(r.conversation_owner) ?? { totalTokens: 0, convs: new Set<string>() }
    u.totalTokens += rowTokens(r.usage).total
    u.convs.add(r.conversation_id)
    byUser.set(r.conversation_owner, u)
  }
  const users = [...byUser.entries()]
    .map(([id, v]) => ({ id, name: nameOf(id), totalTokens: v.totalTokens, conversations: v.convs.size }))
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 10)

  return {
    range: rangeDays,
    overview: { ...overviewOf(current), prev: overviewOf(previous) },
    trend,
    models,
    users,
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run plugins/llm-dashboard`
Expected: PASS（7 个用例全绿）。

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts plugins/llm-dashboard/aggregate.ts plugins/llm-dashboard/__tests__/aggregate.test.ts
git commit -m "feat(llm-dashboard): pure aggregateStats + unit tests"
```

---

### Task 2: 后端 listener 查库聚合 + 前端拉取渲染总览数字（端到端打通真实数据）

**Files:**
- Modify: `plugins/llm-dashboard/index.ts`（整体替换 spike 内容）
- Modify: `plugins/llm-dashboard/client/index.js`（整体替换 hello world）

**Interfaces:**
- Consumes: `aggregateStats`、`UsageRow`、`DashboardStats`（Task 1）。
- Produces: console 事件 `'llm-dashboard/stats'`，入参 `{ range: 7 | 30 | 90 }`，返回 `DashboardStats`。

- [ ] **Step 1: 重写后端 `index.ts`**

Replace 全文 `plugins/llm-dashboard/index.ts`:

```ts
import { Context } from 'koishi'

import { resolve } from 'node:path'

import {} from '@koishijs/console'

import { aggregateStats, type UsageRow } from './aggregate'

// 注：本文件在 tsconfig include 之外，IDE 若对下方事件名类型增强报噪音属已知非阻塞，运行时正常。
declare module '@koishijs/console' {
  interface Events {
    'llm-dashboard/stats'(payload: { range: number }): ReturnType<typeof aggregateStats>
  }
}

const DAY = 86_400_000
const ALLOWED_RANGES = new Set([7, 30, 90])

export const name = 'llm-dashboard'
export const inject = ['console', 'database']

export function apply(ctx: Context) {
  ctx.console.addListener(
    'llm-dashboard/stats',
    async ({ range }) => {
      const rangeDays = ALLOWED_RANGES.has(range) ? range : 30
      const now = Date.now()
      const since = now - 2 * rangeDays * DAY

      const rows = (await ctx.database.get(
        'openai_chat',
        { role: 'assistant', time: { $gte: since } },
        { fields: ['time', 'model', 'conversation_owner', 'usage', 'conversation_id'] }
      )) as unknown as UsageRow[]

      const ownerIds = [...new Set(rows.map((r) => r.conversation_owner))]
      const users = ownerIds.length
        ? await ctx.database.get('user', { id: ownerIds }, { fields: ['id', 'name'] })
        : []
      const nameMap = new Map(users.map((u) => [u.id, u.name]))
      const nameOf = (id: number) => nameMap.get(id) || `#${id}`

      return aggregateStats(rows, rangeDays, now, nameOf)
    },
    { authority: 3 }
  )

  // entry 必须走 node_modules 路径，否则被 console serveAssets 的 403 守卫拦（见 spec）。
  const clientDir = resolve(ctx.baseDir, 'node_modules/koishi-plugin-llm-dashboard/client')
  ctx.console.addEntry({ dev: clientDir, prod: clientDir })
}
```

- [ ] **Step 2: 重写前端 `client/index.js`（先只渲染总览数字，验证真实数据链路）**

Replace 全文 `plugins/llm-dashboard/client/index.js`:

```js
import { defineComponent, h, onMounted, ref } from '../vue.js'
import { send } from '../client.js'

const Dashboard = defineComponent({
  name: 'LlmDashboard',
  setup() {
    const stats = ref(null)
    const loading = ref(false)
    const error = ref('')

    async function load(range = 30) {
      loading.value = true
      error.value = ''
      try {
        stats.value = await send('llm-dashboard/stats', { range })
      } catch (err) {
        error.value = err?.message ?? String(err)
      } finally {
        loading.value = false
      }
    }

    onMounted(() => load())

    return () => {
      const KLayout = h('div')
      const s = stats.value
      const body = error.value
        ? h('p', { style: 'color:var(--k-color-danger,#e05)' }, '加载失败：' + error.value)
        : !s
          ? h('p', loading.value ? '加载中…' : '（无数据）')
          : h('pre', { style: 'white-space:pre-wrap' }, JSON.stringify(s.overview, null, 2))
      return h('k-layout', null, {
        default: () => h('k-card', { style: 'margin:1.5rem' }, { default: () => body }),
      })
    }
  },
})

export default (ctx) => {
  ctx.page({
    path: '/llm-dashboard',
    name: 'LLM 用量',
    authority: 3,
    order: 100,
    component: Dashboard,
  })
}
```

（注：`k-layout` / `k-card` 用字符串标签名即可，console 已全局注册；无需 `resolveComponent`。上面 `KLayout` 占位变量可删，保留不影响。为清爽起见实现时删掉那行。）

- [ ] **Step 3: 重启并在浏览器验证真实数据**

Run: `docker compose restart core`，等约 10s。
用 claude-in-chrome 打开 `http://localhost:3100/dash/`，点侧边栏「LLM 用量」，确认卡片里显示的是**真实的 overview JSON**（calls / totalTokens / activeUsers 等为真实非零数字，或数据库为空时为 0，但不报错）。
读浏览器控制台确认无红色异常。

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-dashboard/index.ts plugins/llm-dashboard/client/index.js
git commit -m "feat(llm-dashboard): real stats listener + overview data path"
```

---

### Task 3: 范围切换器 + 刷新按钮 + 总览卡片（含环比）

**Files:**
- Modify: `plugins/llm-dashboard/client/index.js`

**Interfaces:**
- Consumes: `stats.overview`（含 `prev`）、`send('llm-dashboard/stats', { range })`。

- [ ] **Step 1: 重写 `client/index.js`，加范围切换、刷新、总览卡片**

Replace 全文 `plugins/llm-dashboard/client/index.js`:

```js
import { defineComponent, h, onMounted, ref } from '../vue.js'
import { send } from '../client.js'

const RANGES = [
  { value: 7, label: '7 天' },
  { value: 30, label: '30 天' },
  { value: 90, label: '90 天' },
]

function fmt(n) {
  return (n ?? 0).toLocaleString('en-US')
}

// 环比：返回 { text, cls }
function delta(cur, prev) {
  if (!prev) return { text: '—', cls: 'flat' }
  const pct = ((cur - prev) / prev) * 100
  const sign = pct > 0 ? '↑' : pct < 0 ? '↓' : ''
  return { text: `${sign} ${Math.abs(pct).toFixed(0)}%`, cls: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat' }
}

function overviewCards(o) {
  const cards = [
    { label: '调用次数', cur: o.calls, prev: o.prev.calls },
    { label: '总 Token', cur: o.totalTokens, prev: o.prev.totalTokens },
    { label: '活跃用户', cur: o.activeUsers, prev: o.prev.activeUsers },
    { label: '会话数', cur: o.conversations, prev: o.prev.conversations },
  ]
  return h(
    'div',
    { class: 'ld-cards' },
    cards.map((c) => {
      const d = delta(c.cur, c.prev)
      return h('div', { class: 'ld-card' }, [
        h('div', { class: 'ld-card-label' }, c.label),
        h('div', { class: 'ld-card-value' }, fmt(c.cur)),
        h('div', { class: `ld-delta ld-${d.cls}` }, d.text),
      ])
    })
  )
}

const Dashboard = defineComponent({
  name: 'LlmDashboard',
  setup() {
    const stats = ref(null)
    const loading = ref(false)
    const error = ref('')
    const range = ref(30)

    async function load() {
      loading.value = true
      error.value = ''
      try {
        stats.value = await send('llm-dashboard/stats', { range: range.value })
      } catch (err) {
        error.value = err?.message ?? String(err)
      } finally {
        loading.value = false
      }
    }

    function pick(v) {
      if (range.value === v) return
      range.value = v
      load()
    }

    onMounted(load)

    return () => {
      const s = stats.value
      const toolbar = h('div', { class: 'ld-toolbar' }, [
        h(
          'div',
          { class: 'ld-ranges' },
          RANGES.map((r) =>
            h(
              'button',
              { class: ['ld-range', range.value === r.value ? 'active' : ''], onClick: () => pick(r.value) },
              r.label
            )
          )
        ),
        h('button', { class: 'ld-refresh', disabled: loading.value, onClick: load }, loading.value ? '刷新中…' : '刷新'),
      ])

      const content = error.value
        ? h('k-card', { class: 'ld-error' }, { default: () => '加载失败：' + error.value })
        : !s
          ? h('k-card', {}, { default: () => (loading.value ? '加载中…' : '（无数据）') })
          : h('div', { class: 'ld-grid' }, [overviewCards(s.overview)])

      return h('k-layout', null, { default: () => h('div', { class: 'ld-root' }, [toolbar, content]) })
    }
  },
})

export default (ctx) => {
  ctx.page({ path: '/llm-dashboard', name: 'LLM 用量', authority: 3, order: 100, component: Dashboard })
}
```

- [ ] **Step 2: 重启并验证**

Run: `docker compose restart core`，等 10s。浏览器进「LLM 用量」，确认：四张总览卡片显示、带环比箭头；点 7/30/90 天切换会重新加载并变数字；点「刷新」有 loading 态。控制台无异常。

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-dashboard/client/index.js
git commit -m "feat(llm-dashboard): range switcher, refresh, overview cards"
```

---

### Task 4: 模型排行 + TOP 用户排行（CSS 横条）

**Files:**
- Modify: `plugins/llm-dashboard/client/index.js`

**Interfaces:**
- Consumes: `stats.models`、`stats.users`。

- [ ] **Step 1: 加两个排行渲染函数并插入 grid**

在 `client/index.js` 里，`overviewCards` 函数之后新增：

```js
function rankRows(items, maxKey, rows) {
  const max = Math.max(1, ...items.map((it) => it[maxKey]))
  return items.map((it) =>
    h('div', { class: 'ld-rank-row' }, [
      h('div', { class: 'ld-rank-bar', style: `width:${(it[maxKey] / max) * 100}%` }),
      h('div', { class: 'ld-rank-content' }, rows(it)),
    ])
  )
}

function modelPanel(models) {
  return h('k-card', { class: 'ld-panel' }, {
    header: () => '各模型消耗',
    default: () =>
      models.length
        ? h('div', { class: 'ld-ranks' }, rankRows(models, 'totalTokens', (m) => [
            h('span', { class: 'ld-rank-name' }, m.model),
            h('span', { class: 'ld-rank-metric' }, `${fmt(m.totalTokens)} tok · ${fmt(m.calls)} 次`),
          ]))
        : h('p', { class: 'ld-empty' }, '（无数据）'),
  })
}

function userPanel(users) {
  return h('k-card', { class: 'ld-panel' }, {
    header: () => 'TOP 用户',
    default: () =>
      users.length
        ? h('div', { class: 'ld-ranks' }, rankRows(users, 'totalTokens', (u) => [
            h('span', { class: 'ld-rank-name' }, u.name),
            h('span', { class: 'ld-rank-metric' }, `${fmt(u.totalTokens)} tok · ${fmt(u.conversations)} 会话`),
          ]))
        : h('p', { class: 'ld-empty' }, '（无数据）'),
  })
}
```

- [ ] **Step 2: 把两个面板插进 grid**

把 render 里的这一行：

```js
          : h('div', { class: 'ld-grid' }, [overviewCards(s.overview)])
```

改为：

```js
          : h('div', { class: 'ld-grid' }, [
              overviewCards(s.overview),
              h('div', { class: 'ld-panels' }, [modelPanel(s.models), userPanel(s.users)]),
            ])
```

- [ ] **Step 3: 重启并验证**

Run: `docker compose restart core`，等 10s。浏览器确认：两个排行面板出现，横条按 token 比例、名称 + 数值显示；切换范围数据随之变化。控制台无异常。

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-dashboard/client/index.js
git commit -m "feat(llm-dashboard): model & top-user ranking panels"
```

---

### Task 5: 用量趋势图（手绘 SVG，零依赖）

**Files:**
- Modify: `plugins/llm-dashboard/client/index.js`

**Interfaces:**
- Consumes: `stats.trend`（`{ date, promptTokens, completionTokens, calls }[]`）。

- [ ] **Step 1: 加 SVG 趋势构建函数**

在 `client/index.js` 里 `userPanel` 之后新增（用 innerHTML 注入 SVG 字符串，规避 Vue 的 SVG 命名空间问题）：

```js
function buildTrendSvg(trend) {
  const W = 720
  const H = 200
  const pad = { l: 8, r: 8, t: 12, b: 20 }
  const n = trend.length
  const max = Math.max(1, ...trend.map((d) => d.promptTokens + d.completionTokens))
  const iw = W - pad.l - pad.r
  const ih = H - pad.t - pad.b
  const x = (i) => pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw)
  const y = (v) => pad.t + ih - (v / max) * ih

  const promptPts = trend.map((d, i) => `${x(i)},${y(d.promptTokens)}`)
  const totalPts = trend.map((d, i) => `${x(i)},${y(d.promptTokens + d.completionTokens)}`)
  const base = `${pad.l + iw},${pad.t + ih} ${pad.l},${pad.t + ih}`

  const totalArea = `<polygon points="${totalPts.join(' ')} ${base}" fill="var(--k-color-primary,#6a5acd)" fill-opacity="0.18"/>`
  const promptArea = `<polygon points="${promptPts.join(' ')} ${base}" fill="var(--k-color-primary,#6a5acd)" fill-opacity="0.35"/>`
  const totalLine = `<polyline points="${totalPts.join(' ')}" fill="none" stroke="var(--k-color-primary,#6a5acd)" stroke-width="1.5"/>`

  const first = trend[0]?.date ?? ''
  const last = trend[n - 1]?.date ?? ''
  const labels =
    `<text x="${pad.l}" y="${H - 6}" font-size="11" fill="var(--k-text-light,#999)">${first}</text>` +
    `<text x="${W - pad.r}" y="${H - 6}" font-size="11" text-anchor="end" fill="var(--k-text-light,#999)">${last}</text>`

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">${totalArea}${promptArea}${totalLine}${labels}</svg>`
}

function trendPanel(trend) {
  return h('k-card', { class: 'ld-panel ld-trend' }, {
    header: () => '用量趋势（下层 prompt / 上层含 completion）',
    default: () => h('div', { class: 'ld-chart', innerHTML: buildTrendSvg(trend) }),
  })
}
```

- [ ] **Step 2: 把趋势面板插进 grid（放在总览卡片之后、排行之前）**

把：

```js
          : h('div', { class: 'ld-grid' }, [
              overviewCards(s.overview),
              h('div', { class: 'ld-panels' }, [modelPanel(s.models), userPanel(s.users)]),
            ])
```

改为：

```js
          : h('div', { class: 'ld-grid' }, [
              overviewCards(s.overview),
              trendPanel(s.trend),
              h('div', { class: 'ld-panels' }, [modelPanel(s.models), userPanel(s.users)]),
            ])
```

- [ ] **Step 3: 重启并验证**

Run: `docker compose restart core`，等 10s。浏览器确认：趋势面板出现，SVG 面积图随天数铺开、有首尾日期标签；切 7/30/90 天曲线随之变化。控制台无异常。

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-dashboard/client/index.js
git commit -m "feat(llm-dashboard): hand-drawn SVG usage trend chart"
```

---

### Task 6: 样式 `style.css`

**Files:**
- Create: `plugins/llm-dashboard/client/style.css`

**Interfaces:** 无（纯样式；console 检测到 `style.css` 会随 entry 一起注入）。

- [ ] **Step 1: 写样式**

Create `plugins/llm-dashboard/client/style.css`:

```css
.ld-root { padding: 1.5rem; display: flex; flex-direction: column; gap: 1rem; }
.ld-toolbar { display: flex; justify-content: space-between; align-items: center; }
.ld-ranges { display: flex; gap: 0.5rem; }
.ld-range, .ld-refresh {
  padding: 0.35rem 0.9rem; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--k-color-border, #d0d0d0);
  background: var(--k-card-bg, #fff); color: inherit; font-size: 0.9rem;
}
.ld-range.active { background: var(--k-color-primary, #6a5acd); color: #fff; border-color: transparent; }
.ld-refresh:disabled { opacity: 0.5; cursor: default; }

.ld-grid { display: flex; flex-direction: column; gap: 1rem; }
.ld-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1rem; }
.ld-card {
  background: var(--k-card-bg, #fff); border: 1px solid var(--k-color-border, #eee);
  border-radius: 8px; padding: 1rem 1.2rem;
}
.ld-card-label { font-size: 0.85rem; color: var(--k-text-light, #888); }
.ld-card-value { font-size: 1.6rem; font-weight: 600; margin: 0.25rem 0; }
.ld-delta { font-size: 0.8rem; }
.ld-up { color: #e0533d; }
.ld-down { color: #2ca05a; }
.ld-flat { color: var(--k-text-light, #999); }

.ld-panels { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
@media (max-width: 900px) { .ld-panels { grid-template-columns: 1fr; } }
.ld-ranks { display: flex; flex-direction: column; gap: 0.3rem; }
.ld-rank-row { position: relative; padding: 0.4rem 0.6rem; border-radius: 4px; overflow: hidden; }
.ld-rank-bar {
  position: absolute; inset: 0 auto 0 0; background: var(--k-color-primary, #6a5acd);
  opacity: 0.14; border-radius: 4px;
}
.ld-rank-content { position: relative; display: flex; justify-content: space-between; gap: 1rem; font-size: 0.9rem; }
.ld-rank-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ld-rank-metric { color: var(--k-text-light, #888); white-space: nowrap; }
.ld-empty { color: var(--k-text-light, #999); }
.ld-chart { width: 100%; }
.ld-trend .ld-chart { line-height: 0; }
.ld-error { color: var(--k-color-danger, #e0533d); }
```

- [ ] **Step 2: 重启并验证样式生效**

Run: `docker compose restart core`，等 10s。浏览器确认：卡片/面板/横条/图表都有样式（网络请求里 `@plugin-<key>/style.css` 为 200）。深色主题下文字/边框可读。

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-dashboard/client/style.css
git commit -m "feat(llm-dashboard): dashboard styles"
```

---

### Task 7: 生产 docker 挂载 + 收尾格式化

**Files:**
- Modify: `docker-compose.yml`
- Modify: `src/index.ts`（import 排序归位）

- [ ] **Step 1: 生产 compose 加 plugins 挂载**

在 `docker-compose.yml` 的 `core.volumes` 里，`- ./tsconfig.json:/app/tsconfig.json` 之后加一行（**只加这一行，勿动他人已有的注释改动**）：

```yaml
      - ./plugins/:/app/plugins
```

- [ ] **Step 2: 归正 `src/index.ts` 的 import 排序**

把 `import * as PluginLlmDashboard from 'koishi-plugin-llm-dashboard'` 从当前（`@cordisjs`/puppeteer 之后的相对组位置）移动到 `koishi-plugin-` 组内的字母序位置——在 `import * as PluginImageSearch from 'koishi-plugin-image-search'` 之后、`import * as PluginManosabaMemes from 'koishi-plugin-manosaba-memes'` 之前：

```ts
import * as PluginImageSearch from 'koishi-plugin-image-search'
import * as PluginLlmDashboard from 'koishi-plugin-llm-dashboard'
import * as PluginManosabaMemes from 'koishi-plugin-manosaba-memes'
```

并删除原来在 puppeteer 之后那行（连同其空行组）。

- [ ] **Step 3: 只格式化本次改动的文件**

Run: `npx prettier --write plugins/llm-dashboard/index.ts plugins/llm-dashboard/aggregate.ts plugins/llm-dashboard/__tests__/aggregate.test.ts src/index.ts`
（`client/*.js`、`style.css` 若被 prettier 动，检查 diff 无害即可；不确定就跳过它们。）

- [ ] **Step 4: 全量测试 + 确认启动**

Run: `npx vitest run plugins/llm-dashboard`（PASS）。
Run: `docker compose restart core`，等 10s，浏览器最终巡检整页四面板正常、控制台无异常。

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml src/index.ts plugins/llm-dashboard/
git commit -m "chore(llm-dashboard): prod plugins mount, import order, formatting"
```

---

### Task 8（可选，纯 IDE 类型糖）: 让 TS 认识 `../vue.js` / `../client.js`

**目的：** 仅为编辑器里写 `client/*.js` 时有类型/自动补全；运行时零影响。不想要可整个跳过。

**背景约束（别踩）：**
- TS 的 `paths` 与 ambient `declare module` 只对**裸说明符**生效，无法映射相对路径 `../vue.js`。唯一办法是在解析位置放真 d.ts。
- 不能改成裸 `import from 'vue'` 靠 console `transformImport` 重写——项目 prettier `semi: false`，而该正则要求 import 带结尾分号，改了也不会被重写。所以 `client/*.js` 保持 `../vue.js` / `../client.js` 写法。

**Files:**
- Modify: `plugins/llm-dashboard/package.json`（加 `vue` devDependency）
- Create: `plugins/llm-dashboard/vue.d.ts`
- Create: `plugins/llm-dashboard/client.d.ts`
- Create: `plugins/llm-dashboard/tsconfig.json`

- [ ] **Step 1: 装 vue 类型（轻量 devDep）**

Run: `bun add -D vue --cwd plugins/llm-dashboard`
（或手动在 `plugins/llm-dashboard/package.json` 加 `"devDependencies": { "vue": "^3.5.0" }` 后 `bun install`。）

- [ ] **Step 2: 建伪包 d.ts（放在 client 的上一级，对上 `../vue.js` / `../client.js`）**

Create `plugins/llm-dashboard/vue.d.ts`:

```ts
// Type shim for the console-provided ../vue.js pseudo-package.
// TS (Bundler resolution) resolves the client's `../vue.js` import to this file.
export * from 'vue'
```

Create `plugins/llm-dashboard/client.d.ts`:

```ts
// Type shim for the console-provided ../client.js pseudo-package
// (@koishijs/client runtime). Hand-declare only what client/*.js uses so we
// don't need to install the heavy @koishijs/client package.
export function send(type: string, ...args: any[]): Promise<any>
```

- [ ] **Step 3: scoped tsconfig，让编辑器解析 client 的 js**

Create `plugins/llm-dashboard/tsconfig.json`:

```jsonc
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowJs": true,
    "checkJs": false,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["client", "vue.d.ts", "client.d.ts", "index.ts", "aggregate.ts"]
}
```

- [ ] **Step 4: 验证 IDE 解析**

在编辑器打开 `plugins/llm-dashboard/client/index.js`，确认 `import { defineComponent, h, ref } from '../vue.js'` 与 `import { send } from '../client.js'` 不再报"找不到模块"，`send` / `h` 有类型提示。运行时不受影响：`docker compose restart core` 后页面照常。

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-dashboard/package.json plugins/llm-dashboard/vue.d.ts plugins/llm-dashboard/client.d.ts plugins/llm-dashboard/tsconfig.json bun.lock
git commit -m "chore(llm-dashboard): IDE type shims for ../vue.js & ../client.js pseudo-packages"
```

---

## 收尾（人类在环）

- 全部 task 完成后，`git push`，按需开 PR（`feat/llm-dashboard` → master）。
- 部署到生产时：`docker-compose.yml` 已含 `./plugins` 挂载 + `bun.lock` 已含 workspace 成员，`git pull` 后 `docker compose up -d core`（**注意：加了新挂载，首次要 `up -d` 不是 `restart`**），等 core 日志就绪。

## Self-Review 记录

- 覆盖 spec：总览/趋势/模型/用户四面板（Task 3/5/4）、范围切换+刷新（Task 3）、JS 内存聚合+usage 陷阱（Task 1）、send/addListener 契约（Task 2）、authority 3（Task 2）、node_modules serve 约束（Task 2 addEntry）、生产挂载（Task 7）、用户名补全（Task 2 nameOf + user.name）。
- 类型一致：`aggregateStats` 签名 / `DashboardStats` 字段在 Task 1 定义，Task 2 消费，前端字段名（overview/trend/models/users 及子字段）与之对齐。
- 无占位符：各步含完整代码/命令/预期。
