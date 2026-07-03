# GitHub 插件 Phase 1：Webhook 核心恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 自研 `src/plugins/github/` 的 webhook 收取内核，替换停更插件里坏掉的签名校验，使生产已注册的 GitHub webhook 立即恢复向订阅群推送（先支持 `push` 事件）。

**Architecture:** 纯函数内核 `handleWebhook`（校验签名 + 解析 + 定位订阅目标 + 渲染）与 koa 路由胶水分离；订阅关系用内存索引 `SubscriptionStore`（`ready` 时从 `channel.github.webhooks` 重建）；签名用 `@octokit/webhooks-methods` 的 `verify` 对 **raw body** 校验（修复点）。复用旧插件的 DB 表与 secret，零重订阅。

**Tech Stack:** koishi 4.18（bun runtime）、`@satorijs/element` JSX、`@octokit/webhooks-methods`、vitest。设计见 `docs/superpowers/specs/2026-07-01-github-plugin-design.md`，根因见 `.debug/github-plugin/root-cause-verified.md`。

## Global Constraints

- **包管理器只用 bun**：`bun add ...`，禁用 pnpm（否则多实例 koishi，见 CLAUDE.local.md）。
- **DB schema / secret / 路由不可变**（兼容生产存量 webhook）：`github` 表 `{ id:'integer', name:'string(50)', secret:'string(50)' }`；`channel.github.webhooks:'json'`；`user.github.accessToken/refreshToken:'string(50)'`；webhook 路由 `POST <path>/webhook`（生产 `path='/api/github'`）。
- **签名方案不可变**：HMAC-SHA256 over **raw request body**，header `x-hub-signature-256: sha256=<hex>`；webhook content-type 为 GitHub 默认的 `application/x-www-form-urlencoded`（raw body 形如 `payload=%7B...%7D`，解析走 `body.payload`）。
- **原始字节取值**：`koa.request.body[Symbol.for('unparsedBody')]`（koa-body v6 的 unparsed 挂点，**绝不能**用已废弃的 `request.rawBody` 或重新 `JSON.stringify(body)`）。
- 路径别名：`~/*`→`src/plugins/*`，`$utils/*`→`src/utils/*`，`@/*`→`src/*`。
- 注释用英文；测试放同级 `__tests__/`。

---

### Task 1: 加依赖 + 类型定义

**Files:**
- Modify: `package.json`（新增 dependency `@octokit/webhooks-methods`）
- Create: `src/plugins/github/types.ts`

**Interfaces:**
- Produces:
  - `interface Config`（path/appId/appSecret/redirect/messagePrefix/replyFooter/replyTimeout，均可选）
  - `type EventFilter = Record<string, boolean | Record<string, boolean>>`
  - `type RepoConfig = Record<string, EventFilter>`（key = cid `platform:id`）
  - `type EventRenderer = (payload: any) => import('koishi').Fragment | null`

- [ ] **Step 1: 安装 runtime 依赖**

Run: `bun add @octokit/webhooks-methods`
Expected: `package.json` 出现 `@octokit/webhooks-methods`，`bun.lock` 更新，无报错。

- [ ] **Step 2: 写类型文件**

Create `src/plugins/github/types.ts`:

```ts
import type { Fragment } from 'koishi'

export interface Config {
  /** Base path of the GitHub service routes. Prod uses '/api/github'. */
  path?: string
  appId?: string
  appSecret?: string
  redirect?: string
  /** Prepended to every pushed message. */
  messagePrefix?: string
  replyFooter?: string
  replyTimeout?: number
}

/** Per-channel event filter meta, keyed by camelized event name.
 * `false` disables the whole event; a nested map disables specific camelized actions. */
export type EventFilter = Record<string, boolean | Record<string, boolean>>

/** A repo's subscribers: cid ('platform:id') -> filter meta. */
export type RepoConfig = Record<string, EventFilter>

/** Renders a parsed webhook payload into a chat message, or null to skip. */
export type EventRenderer = (payload: any) => Fragment | null
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit -p .`
Expected: 无与该文件相关的错误。

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock src/plugins/github/types.ts
git commit -m "feat(github): add webhook deps and shared types"
```

---

### Task 2: 签名校验（修复点，golden test）

**Files:**
- Create: `src/plugins/github/verify.ts`
- Test: `src/plugins/github/__tests__/verify.test.ts`

**Interfaces:**
- Consumes: `@octokit/webhooks-methods` 的 `verify`
- Produces: `isSignatureValid(secret: string, rawBody: string | undefined, signature: string | undefined): Promise<boolean>`

- [ ] **Step 1: 写失败测试**

Create `src/plugins/github/__tests__/verify.test.ts`:

```ts
import { createHmac } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { isSignatureValid } from '../verify'

const sign = (secret: string, raw: string) =>
  'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')

describe('isSignatureValid', () => {
  const secret = 's3cr3t'
  const json = JSON.stringify({ zen: 'Keep it simple.' })
  // GitHub default content-type: x-www-form-urlencoded, raw body = "payload=<urlencoded json>"
  const raw = 'payload=' + encodeURIComponent(json)

  it('accepts a correct signature over the raw urlencoded body', async () => {
    expect(await isSignatureValid(secret, raw, sign(secret, raw))).toBe(true)
  })

  it('rejects a tampered body', async () => {
    expect(await isSignatureValid(secret, raw + 'x', sign(secret, raw))).toBe(false)
  })

  // Regression: the OLD bug signed re-serialized JSON instead of the raw body. Keep it dead.
  it('rejects a signature computed over re-serialized JSON, not the raw body', async () => {
    expect(await isSignatureValid(secret, raw, sign(secret, json))).toBe(false)
  })

  it('rejects when secret / body / signature are missing', async () => {
    expect(await isSignatureValid('', raw, sign(secret, raw))).toBe(false)
    expect(await isSignatureValid(secret, undefined, sign(secret, raw))).toBe(false)
    expect(await isSignatureValid(secret, raw, undefined)).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/plugins/github/__tests__/verify.test.ts`
Expected: FAIL（`Cannot find module '../verify'`）。

- [ ] **Step 3: 写实现**

Create `src/plugins/github/verify.ts`:

```ts
import { verify } from '@octokit/webhooks-methods'

/**
 * Validate a GitHub webhook signature against the RAW request body as received
 * (bytes on the wire). Never pass a re-serialized/parsed body — the HMAC would
 * not match GitHub's signature. See root-cause-verified.md.
 */
export async function isSignatureValid(
  secret: string,
  rawBody: string | undefined,
  signature: string | undefined
): Promise<boolean> {
  if (!secret || !rawBody || !signature) return false
  return verify(secret, rawBody, signature)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/plugins/github/__tests__/verify.test.ts`
Expected: PASS（4 个用例全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/plugins/github/verify.ts src/plugins/github/__tests__/verify.test.ts
git commit -m "feat(github): raw-body HMAC signature verification"
```

---

### Task 3: 订阅索引与事件过滤

**Files:**
- Create: `src/plugins/github/subscribe.ts`
- Test: `src/plugins/github/__tests__/subscribe.test.ts`

**Interfaces:**
- Consumes: `camelize`（koishi）；`RepoConfig` / `EventFilter`（Task 1）
- Produces:
  - `filterTargets(repoConfig: RepoConfig, event: string, action?: string): string[]`
  - `class SubscriptionStore { subscribe(repo, cid, meta); unsubscribe(repo, cid?); targets(repo, event, action?): string[] }`

- [ ] **Step 1: 写失败测试**

Create `src/plugins/github/__tests__/subscribe.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { filterTargets, SubscriptionStore } from '../subscribe'

describe('filterTargets', () => {
  it('includes a channel with empty meta (no filters)', () => {
    expect(filterTargets({ 'mock:1': {} }, 'push')).toEqual(['mock:1'])
  })
  it('excludes a channel that disabled the event', () => {
    expect(filterTargets({ 'mock:1': { push: false } }, 'push')).toEqual([])
  })
  it('excludes a channel that disabled the specific action', () => {
    expect(filterTargets({ 'mock:1': { issues: { opened: false } } }, 'issues', 'opened')).toEqual([])
  })
  it('includes when a different action is disabled', () => {
    expect(filterTargets({ 'mock:1': { issues: { closed: false } } }, 'issues', 'opened')).toEqual(['mock:1'])
  })
  it('camelizes hyphenated/underscored events', () => {
    expect(filterTargets({ 'mock:1': { pullRequest: false } }, 'pull_request', 'opened')).toEqual([])
  })
  it('event===true includes regardless of action', () => {
    expect(filterTargets({ 'mock:1': { issues: true } }, 'issues', 'closed')).toEqual(['mock:1'])
  })
})

describe('SubscriptionStore', () => {
  it('subscribes and resolves targets', () => {
    const s = new SubscriptionStore()
    s.subscribe('org/repo', 'mock:1', {})
    expect(s.targets('org/repo', 'push')).toEqual(['mock:1'])
  })
  it('unsubscribe one cid leaves others', () => {
    const s = new SubscriptionStore()
    s.subscribe('org/repo', 'mock:1', {})
    s.subscribe('org/repo', 'mock:2', {})
    s.unsubscribe('org/repo', 'mock:1')
    expect(s.targets('org/repo', 'push')).toEqual(['mock:2'])
  })
  it('unsubscribe without cid drops the whole repo', () => {
    const s = new SubscriptionStore()
    s.subscribe('org/repo', 'mock:1', {})
    s.unsubscribe('org/repo')
    expect(s.targets('org/repo', 'push')).toEqual([])
  })
  it('unknown repo yields no targets', () => {
    expect(new SubscriptionStore().targets('nope/nope', 'push')).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/plugins/github/__tests__/subscribe.test.ts`
Expected: FAIL（`Cannot find module '../subscribe'`）。

- [ ] **Step 3: 写实现**

Create `src/plugins/github/subscribe.ts`:

```ts
import { camelize } from 'koishi'
import type { EventFilter, RepoConfig } from './types'

/**
 * Pure: given a repo's per-channel filter config and an event/action, return the
 * cids that should receive it. Mirrors the old plugin's camelize-based filtering.
 */
export function filterTargets(
  repoConfig: RepoConfig,
  event: string,
  action?: string
): string[] {
  return Object.keys(repoConfig).filter((cid) => {
    const base = repoConfig[cid][camelize(event)] ?? {}
    if (base === false) return false
    if (action && base !== true) {
      const actionConfig = (base as Record<string, boolean>)[camelize(action)]
      if (actionConfig === false) return false
    }
    return true
  })
}

/** In-memory index: repo (lowercase full_name) -> { cid -> filter meta }. */
export class SubscriptionStore {
  private map: Record<string, RepoConfig> = Object.create(null)

  subscribe(repo: string, cid: string, meta: EventFilter) {
    ;(this.map[repo] ||= Object.create(null))[cid] = meta
  }

  unsubscribe(repo: string, cid?: string) {
    if (!cid) {
      delete this.map[repo]
      return
    }
    if (this.map[repo]) {
      delete this.map[repo][cid]
      if (!Object.keys(this.map[repo]).length) delete this.map[repo]
    }
  }

  targets(repo: string, event: string, action?: string): string[] {
    const cfg = this.map[repo]
    return cfg ? filterTargets(cfg, event, action) : []
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/plugins/github/__tests__/subscribe.test.ts`
Expected: PASS（全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/plugins/github/subscribe.ts src/plugins/github/__tests__/subscribe.test.ts
git commit -m "feat(github): in-memory subscription index and event filtering"
```

---

### Task 4: push 事件渲染器

**Files:**
- Create: `src/plugins/github/events/push.ts`
- Create: `src/plugins/github/events/index.ts`
- Test: `src/plugins/github/__tests__/push.test.ts`

**Interfaces:**
- Consumes: `EventRenderer`（Task 1）
- Produces:
  - `renderPush: EventRenderer`
  - `renderers: Record<string, EventRenderer>`（Phase 1 只含 `push`）

- [ ] **Step 1: 写失败测试**

Create `src/plugins/github/__tests__/push.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { renderPush } from '../events/push'

const base = {
  pusher: { name: 'alice' },
  sender: { type: 'User' },
  repository: { full_name: 'org/repo' },
  ref: 'refs/heads/main',
  before: 'a'.repeat(40),
  after: 'b'.repeat(40),
  commits: [{ id: 'abcdef1234', message: 'fix: the thing\n\nlong body' }],
}

describe('renderPush', () => {
  it('renders pusher, branch, and first line of each commit', () => {
    expect(renderPush(base)).toBe('alice pushed to org/repo:main\n[abcdef] fix: the thing')
  })
  it('skips bot pushes', () => {
    expect(renderPush({ ...base, sender: { type: 'Bot' } })).toBeNull()
  })
  it('skips branch creation (before all zeros)', () => {
    expect(renderPush({ ...base, before: '0'.repeat(40) })).toBeNull()
  })
  it('skips branch deletion (after all zeros)', () => {
    expect(renderPush({ ...base, after: '0'.repeat(40) })).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/plugins/github/__tests__/push.test.ts`
Expected: FAIL（`Cannot find module '../events/push'`）。

- [ ] **Step 3: 写实现**

Create `src/plugins/github/events/push.ts`:

```ts
import type { EventRenderer } from '../types'

/**
 * Faithful port of the old push renderer. Returns null to skip: bot pushes, and
 * branch create/delete (before/after all-zero SHAs). Commit body is trimmed to
 * its first line (subject) — commit messages are plain text.
 */
export const renderPush: EventRenderer = (payload) => {
  const { pusher, sender, commits, repository, ref, before, after } = payload
  if (sender?.type === 'Bot') return null
  if (/^0+$/.test(before) || /^0+$/.test(after)) return null
  const branch = ref.replace(/^refs\/heads\//, '')
  return [
    `${pusher.name} pushed to ${repository.full_name}:${branch}`,
    ...commits.map((c: any) => `[${c.id.slice(0, 6)}] ${c.message.split('\n')[0]}`),
  ].join('\n')
}
```

Create `src/plugins/github/events/index.ts`:

```ts
import type { EventRenderer } from '../types'
import { renderPush } from './push'

/** event name (x-github-event) -> renderer. Phase 1 ships push only. */
export const renderers: Record<string, EventRenderer> = {
  push: renderPush,
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/plugins/github/__tests__/push.test.ts`
Expected: PASS（4 个用例全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/plugins/github/events src/plugins/github/__tests__/push.test.ts
git commit -m "feat(github): push event renderer"
```

---

### Task 5: webhook 内核 handleWebhook

**Files:**
- Create: `src/plugins/github/webhook.ts`
- Test: `src/plugins/github/__tests__/webhook.test.ts`

**Interfaces:**
- Consumes: `isSignatureValid`（Task 2）、`renderers`（Task 4）、`Config`（Task 1）
- Produces:
  - `interface WebhookDeps { getSecret(hookId: number): Promise<string | undefined>; targets(repo: string, event: string, action?: string): string[] }`
  - `interface WebhookResult { status: number; targets?: string[]; message?: import('koishi').Fragment }`
  - `handleWebhook(headers, rawBody, body, deps): Promise<WebhookResult>`
  - `applyWebhook(ctx: Context, config: Config, deps: WebhookDeps): void`（注册 koa 路由，Task 6 调用）

- [ ] **Step 1: 写失败测试**

Create `src/plugins/github/__tests__/webhook.test.ts`:

```ts
import { createHmac } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { handleWebhook, type WebhookDeps } from '../webhook'

const secret = 's3cr3t'
const payloadObj = {
  repository: { full_name: 'Org/Repo' },
  pusher: { name: 'alice' },
  sender: { type: 'User' },
  ref: 'refs/heads/main',
  before: 'a'.repeat(40),
  after: 'b'.repeat(40),
  commits: [{ id: 'abcdef1', message: 'msg' }],
}
const json = JSON.stringify(payloadObj)
const raw = 'payload=' + encodeURIComponent(json)
const body = { payload: json }
const sig = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')

const headers = (extra: Record<string, any> = {}) => ({
  'x-github-event': 'push',
  'x-github-hook-id': '42',
  'x-hub-signature-256': sig,
  ...extra,
})

const deps: WebhookDeps = {
  getSecret: async (id) => (id === 42 ? secret : undefined),
  targets: () => ['mock:1'],
}

describe('handleWebhook', () => {
  it('200 + targets + message on a valid push', async () => {
    const r = await handleWebhook(headers(), raw, body, deps)
    expect(r.status).toBe(200)
    expect(r.targets).toEqual(['mock:1'])
    expect(r.message).toBe('alice pushed to Org/Repo:main\n[abcdef] msg')
  })
  it('403 on a bad signature', async () => {
    const r = await handleWebhook(headers({ 'x-hub-signature-256': 'sha256=bad' }), raw, body, deps)
    expect(r.status).toBe(403)
  })
  it('202 on an unknown hook id (no stored secret)', async () => {
    const r = await handleWebhook(headers({ 'x-github-hook-id': '999' }), raw, body, deps)
    expect(r.status).toBe(202)
  })
  it('400 when the payload cannot be parsed', async () => {
    const r = await handleWebhook(headers(), 'payload=oops', { payload: 'oops{' }, deps)
    expect(r.status).toBe(400)
  })
  it('200 with no targets when nobody is subscribed', async () => {
    const r = await handleWebhook(headers(), raw, body, { ...deps, targets: () => [] })
    expect(r.status).toBe(200)
    expect(r.targets ?? []).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/plugins/github/__tests__/webhook.test.ts`
Expected: FAIL（`Cannot find module '../webhook'`）。

- [ ] **Step 3: 写实现**

Create `src/plugins/github/webhook.ts`:

```ts
import { Context } from 'koishi'
import { isSignatureValid } from './verify'
import { renderers } from './events'
import type { Config } from './types'

const UNPARSED_BODY = Symbol.for('unparsedBody')

export interface WebhookDeps {
  /** Look up a webhook's shared secret by its GitHub hook id. */
  getSecret(hookId: number): Promise<string | undefined>
  /** Resolve subscribed cids for a repo + event (+ action). */
  targets(repo: string, event: string, action?: string): string[]
}

export interface WebhookResult {
  status: number
  targets?: string[]
  message?: import('koishi').Fragment
}

function safeParse(source: any): any {
  try {
    return JSON.parse(source)
  } catch {
    return undefined
  }
}

/**
 * Pure webhook core: validate signature over the raw body, resolve targets, render.
 * Status codes mirror the old plugin: 400 bad payload, 202 unknown hook, 403 bad
 * signature, 200 otherwise. No koa/HTTP here so it is directly unit-testable.
 */
export async function handleWebhook(
  headers: Record<string, any>,
  rawBody: string | undefined,
  body: any,
  deps: WebhookDeps
): Promise<WebhookResult> {
  const event = String(headers['x-github-event'] ?? '')
  const signature = headers['x-hub-signature-256'] as string | undefined
  const hookId = +headers['x-github-hook-id']
  const payload = safeParse(body?.payload)
  if (!event || !payload?.repository?.full_name) return { status: 400 }

  const secret = await deps.getSecret(hookId)
  if (!secret) return { status: 202 } // unknown hook: repos -a probe window

  if (!(await isSignatureValid(secret, rawBody, signature))) return { status: 403 }

  const repo = payload.repository.full_name.toLowerCase()
  const targets = deps.targets(repo, event, payload.action)
  const render = renderers[event]
  const message = render ? render(payload) : null
  if (!targets.length || message == null) return { status: 200 }
  return { status: 200, targets, message }
}

/** Register the koa webhook route; broadcasts rendered messages to subscribers. */
export function applyWebhook(ctx: Context, config: Config, deps: WebhookDeps): void {
  const prefix = config.messagePrefix ?? ''
  ctx.server.post((config.path ?? '/github') + '/webhook', async (koa) => {
    const reqBody = koa.request.body as any
    const rawBody = reqBody?.[UNPARSED_BODY] as string | undefined
    const result = await handleWebhook(koa.headers, rawBody, reqBody, deps)
    koa.status = result.status
    if (result.targets?.length && result.message != null) {
      const content =
        typeof result.message === 'string' ? prefix + result.message : [prefix, result.message]
      await ctx.broadcast(result.targets, content as any)
    }
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/plugins/github/__tests__/webhook.test.ts`
Expected: PASS（5 个用例全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/plugins/github/webhook.ts src/plugins/github/__tests__/webhook.test.ts
git commit -m "feat(github): webhook core (verify + dispatch) and koa route"
```

---

### Task 6: 插件入口 + 替换注册

**Files:**
- Create: `src/plugins/github/index.ts`
- Modify: `src/index.ts:91`（import）+ `src/index.ts:314`（注册）

**Interfaces:**
- Consumes: `SubscriptionStore`（Task 3）、`applyWebhook`（Task 5）、`Config`（Task 1）、`BasePlugin`（`~/_boilerplate`）
- Produces: `export default class PluginGitHub`（koishi 插件），`export const Config`（Schema）

- [ ] **Step 1: 写插件入口**

Create `src/plugins/github/index.ts`:

```ts
import { Context, Schema, Time } from 'koishi'
import BasePlugin from '~/_boilerplate'
import { SubscriptionStore } from './subscribe'
import { applyWebhook } from './webhook'
import type { Config } from './types'

export type { Config } from './types'

export default class PluginGitHub extends BasePlugin<Config> {
  static inject = ['database', 'server']

  private store = new SubscriptionStore()

  constructor(ctx: Context, config: Config) {
    super(ctx, config, 'github')

    // Reuse the legacy schema verbatim so prod data + registered webhooks keep working.
    ctx.model.extend('user', {
      'github.accessToken': 'string(50)',
      'github.refreshToken': 'string(50)',
    })
    ctx.model.extend('channel', {
      'github.webhooks': 'json',
    })
    ctx.model.extend('github', {
      id: 'integer',
      name: 'string(50)',
      secret: 'string(50)',
    })

    // Rebuild the in-memory subscription index from the channel table on startup.
    ctx.on('ready', async () => {
      const channels = await ctx.database.get('channel', {}, ['id', 'platform', 'github'])
      for (const { id, platform, github } of channels) {
        const webhooks = github?.webhooks ?? {}
        for (const repo in webhooks) {
          this.store.subscribe(repo, `${platform}:${id}`, webhooks[repo])
        }
      }
      this.logger.info('github: subscription index rebuilt')
    })

    applyWebhook(ctx, config, {
      getSecret: async (hookId) => (await ctx.database.get('github', [hookId]))[0]?.secret,
      targets: (repo, event, action) => this.store.targets(repo, event, action),
    })
  }
}

export const Config: Schema<Config> = Schema.object({
  path: Schema.string().default('/github'),
  appId: Schema.string(),
  appSecret: Schema.string(),
  redirect: Schema.string(),
  messagePrefix: Schema.string().default('[GitHub] '),
  replyFooter: Schema.string().role('textarea').default(''),
  replyTimeout: Schema.natural().role('ms').default(Time.hour),
})
```

- [ ] **Step 2: 换掉 src/index.ts 的 import**

在 `src/index.ts` 把第 91 行
```ts
import PluginGithub from 'koishi-plugin-github'
```
改为
```ts
import PluginGithub from '~/github'
```

- [ ] **Step 3: 确认注册块不变**

确认 `src/index.ts` 的注册仍为（无需改动，配置键与新插件兼容）：
```ts
  ctx.plugin(PluginGithub, {
    path: '/api/github',
    appId: env.TOKEN_GITHUB_APPID,
    appSecret: env.TOKEN_GITHUB_APPSECRET,
    replyTimeout: 12 * Time.hour,
    replyFooter: '',
  })
```

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit -p .`
Expected: 无错误（尤其无 `Cannot find module '~/github'`、无 model/Context 报错）。

- [ ] **Step 5: 全量测试**

Run: `npx vitest run src/plugins/github`
Expected: verify / subscribe / push / webhook 四个测试文件全 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/plugins/github/index.ts src/index.ts
git commit -m "feat(github): plugin entry; replace dead koishi-plugin-github registration"
```

---

### Task 7: 真机冒烟验证

**Files:** 无（运行时验证）

- [ ] **Step 1: 重启 core**

Run: `docker compose restart core`（若 `sili-core` 在跑）
等待日志出现启动就绪 + `github: subscription index rebuilt`。

- [ ] **Step 2: 观察 webhook 恢复**

在 GitHub 某已注册仓库的 webhook 设置页点 "Redeliver" 最近一次 push 事件（或推一个 commit）。
Expected:
- `sili-core` 日志**不再**出现 `TypeError: The "data" argument must be...`（`command.js:270` 那条彻底消失）。
- 订阅了该仓库的 QQ 群收到 `[GitHub] <pusher> pushed to <repo>:<branch> ...` 推送。

- [ ] **Step 3: 若未收到，排查**

- 群没收到但无报错 → 该群的 `channel.github.webhooks` 未含该 repo（订阅管理命令在 Phase 3，可临时用 `;debug`/DB 确认订阅存在）。
- 403 → 该仓库 webhook 的 secret 与 `github` 表存量不一致（存量数据问题，非本插件 bug）。

---

## Self-Review

**Spec coverage（对照 spec）：**
- 复用约束表（github/channel/user 表、签名、路由、content_type）→ Task 1/6（model.extend）、Task 2（签名）、Task 5（路由/unparsedBody）。✅
- webhook 数据流（unparsedBody→verify→过滤→广播）→ Task 5 handleWebhook + applyWebhook、Task 3 过滤、Task 6 广播接线。✅
- push 渲染（1:1）→ Task 4。✅
- 测试（签名 golden、渲染快照、订阅过滤）→ Task 2/3/4/5。✅
- **本 Phase 不覆盖**（属后续 Phase，spec 已列）：OAuth、订阅管理命令、其余 8 个事件渲染器、issue/star/reply 交互、github.user 卡片、repo 改名迁移、引用交互 history。→ 见下「后续 Phase」。

**Placeholder 扫描：** 无 TBD/TODO；每个代码步骤含完整实现。✅

**类型一致性：** `EventRenderer`/`RepoConfig`/`EventFilter`/`Config`（Task 1）在 Task 3/4/5/6 一致引用；`WebhookDeps.getSecret/targets` 签名在 Task 5 定义、Task 6 提供，一致。✅

## 已知 Phase 1 局限（后续 Phase 修）

- **仅 push 事件**推送；其余事件到达时 `renderers[event]` 为空 → 200 但不推送（无害）。Phase 2 补齐渲染器。
- **repo 改名**后 `subscriptions` 仍用旧名索引 → 改名仓库暂停推送直到重订阅（secret 按 hookId 查，签名不受影响）。Phase 3 随订阅管理补迁移。
- **无引用交互**（react/comment/close）与 history。Phase 4。
- 订阅关系目前只能靠已存在的 DB 数据；群内 `github -a` 等命令在 Phase 3。

## 后续 Phase（各自独立成 plan）

- **Phase 2**：其余事件渲染器（issues / issue_comment / pull_request_review(_comment) / commit_comment / fork / milestone / star），逐个按 Task 4 模式移植 + 快照测试，注册进 `renderers`。
- **Phase 3**：OAuth（authorize 命令 + 回调路由 + code 交换）+ 订阅管理命令（`github -l/-a/-d`、`github.repos -a/-d/-s` 经 octokit 建/删 webhook）+ repo 改名迁移；命令用 `@koishijs/plugin-mock` + `@koishijs/plugin-database-memory` 集成测试。
- **Phase 4**：交互命令（issue / star）+ 引用回复交互（react/comment/close）+ history（`replyTimeout`，测试用 vitest fake timers）。
- **Phase 5**：`github.user` 卡片（GraphQL contributionCalendar + html 服务瓷砖渲染）。
