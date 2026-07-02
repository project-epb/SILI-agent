# GitHub 插件 Phase 3：OAuth + 订阅管理命令 + 改名迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户能通过 OAuth 授权、注册仓库 webhook、在群里订阅/取消订阅仓库——1:1 复刻旧 `koishi-plugin-github` 的用户侧命令行为，恢复「有人能订阅仓库」的能力；并复刻仓库改名时的订阅迁移。

**Architecture:** 沿用 Phase 1/2 的「纯核 + 薄胶水」范式。REST/OAuth 走 koishi `ctx.http`（Quester），**不引 octokit**（用户已定：方案 A）。可测逻辑（HTTP 请求形状与 401 refresh、OAuth 回调状态机、订阅决策、改名迁移）抽成注入依赖的纯函数单测；koishi 命令/路由 `.action` 是薄适配层，由 `tsc` + 真机冒烟兜底。**不引入 `@koishijs/plugin-mock`**（本仓库无此先例，测试风格是纯函数单测）。

**Tech Stack:** TypeScript、koishi 4.18 `ctx.http`/`ctx.command`/`ctx.server`、vitest。移植源：`node_modules/koishi-plugin-github/lib/{index,command}.js` + `lib/locales/zh-CN.json`。**完整旧行为与 file:line 证据见 `.superpowers/sdd/phase3-research.md`（每个 task 引用其 §编号）——实施者先读它。**

## Global Constraints

- **包管理器只用 bun**（`bun add`，禁 pnpm）。**本阶段不引 octokit / 任何 REST SDK**——REST + OAuth 全走 `ctx.http`。`static inject` 增加 `'http'`。
- **用户侧行为 1:1 复刻旧插件**：所有回复字符串**逐字取自** `node_modules/koishi-plugin-github/lib/locales/zh-CN.json`（不自造；本计划给出关键 key→串作参考，实施者以该 JSON 为准）。命令名/别名/option/authority 与旧一致。
- **数据层复用**（Phase 1 已建，不改 schema）：`user.github.{accessToken,refreshToken}`、`channel.github.webhooks: Record<repoLower, EventFilter>`、`github` 表 `{ id: hookId, name: repoLower, secret }`。订阅写入的 filter meta 为 `{}`（= 全事件启用）。
- **签名/secret 兼容**：新建 webhook 时 `secret = Random.id()`（koishi），`config.url = ctx.server.config.selfUrl + config.path + '/webhook'`，`events: ['*']`，不设 `content_type`（GitHub 默认 form）——与存量一致。
- **OAuth**：scope `admin:repo_hook,repo`；`redirect_uri = config.redirect`（**手动配置的完整 URL**，1:1 旧行为，不从 selfUrl 推导）；code 交换 = `POST https://github.com/login/oauth/access_token`（client_id/secret + code/state/redirect_uri 作 query，`Accept: application/json`）；401 自动 refresh 并回写 token；回调路由返回**裸状态码**（400/403/200，无 HTML）。
- `repoRegExp = /^[\w.-]+\/[\w.-]+$/`；仓库名一律 `.toLowerCase()`。
- Quester 错误状态读 `e.response?.status`（仓库先例：gelbooru/client.ts:98、comfy-ui/client.ts:47）。`ctx.http` 方法：`post(url, data, config)`、`get(url, config)`、`delete(url, config)`；config 支持 `{ params, headers, data }`（先例：gelbooru/comfy-ui client）。**实施者写 http.ts 前先扫一眼这两个 client 确认 Quester 用法。**
- 注释用英文；测试在 `src/plugins/github/__tests__/`。别名 `~/*`→`src/plugins/*`。
- 交互对象（issue/star/引用回复）属 **Phase 4**，本阶段不做。

---

### Task 1: GitHubHttp — ctx.http 层（token 交换 + 401 refresh + 建/删 webhook）

**Files:**
- Create: `src/plugins/github/http.ts`
- Create: `src/plugins/github/__tests__/http.test.ts`
- Modify: `src/plugins/github/types.ts`（加 `OAuthTokens`、`GitHubUser` 类型）

参考：research §1b（getTokens）、§1d（建/删 webhook 的 URL/body）、§4（旧 request 的 auth header + 401 refresh）。

**Interfaces:**
- Produces:
  - `interface OAuthTokens { access_token: string; refresh_token: string }`
  - `interface GitHubUser { id: number; github: { accessToken: string; refreshToken: string } }`（对应 `session.user` 的 `userFields(['id','github'])`）
  - `class GitHubHttp`（构造 `(ctx: Context, config: Config)`）：
    - `getTokens(params: Record<string, any>): Promise<OAuthTokens>`
    - `createWebhook(user: GitHubUser, repo: string, opts: { secret: string; callbackUrl: string }): Promise<{ id: number }>`
    - `deleteWebhook(user: GitHubUser, repo: string, hookId: number): Promise<void>`（忽略 404）

- [ ] **Step 1: 写失败测试**

Create `src/plugins/github/__tests__/http.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { GitHubHttp, type GitHubUser } from '../http'

// Minimal fake koishi Context: only the surface GitHubHttp touches.
function makeCtx(overrides: any = {}) {
  return {
    http: { post: vi.fn(), delete: vi.fn(), get: vi.fn() },
    database: { set: vi.fn().mockResolvedValue(undefined) },
    server: { config: { selfUrl: 'https://sili.example' } },
    ...overrides,
  } as any
}
const config = { appId: 'cid', appSecret: 'csec', path: '/api/github' } as any
const user = (): GitHubUser => ({ id: 7, github: { accessToken: 'at0', refreshToken: 'rt0' } })

describe('getTokens', () => {
  it('posts to the access_token endpoint with client creds + params as query, Accept json', async () => {
    const ctx = makeCtx()
    ctx.http.post.mockResolvedValue({ access_token: 'AT', refresh_token: 'RT' })
    const http = new GitHubHttp(ctx, config)
    const out = await http.getTokens({ code: 'C', state: 'S', redirect_uri: 'R' })
    expect(out).toEqual({ access_token: 'AT', refresh_token: 'RT' })
    expect(ctx.http.post).toHaveBeenCalledWith(
      'https://github.com/login/oauth/access_token',
      {},
      {
        params: { client_id: 'cid', client_secret: 'csec', code: 'C', state: 'S', redirect_uri: 'R' },
        headers: { accept: 'application/json' },
      }
    )
  })
})

describe('createWebhook', () => {
  it('POSTs /repos/{repo}/hooks with events:[*] + config.url/secret + auth header', async () => {
    const ctx = makeCtx()
    ctx.http.post.mockResolvedValue({ id: 42 })
    const http = new GitHubHttp(ctx, config)
    const out = await http.createWebhook(user(), 'org/repo', {
      secret: 'sek', callbackUrl: 'https://sili.example/api/github/webhook',
    })
    expect(out).toEqual({ id: 42 })
    expect(ctx.http.post).toHaveBeenCalledWith(
      'https://api.github.com/repos/org/repo/hooks',
      { events: ['*'], config: { url: 'https://sili.example/api/github/webhook', secret: 'sek' } },
      { headers: { authorization: 'token at0', accept: 'application/vnd.github.v3+json' } }
    )
  })

  it('on 401 refreshes the token, persists it, and retries the call', async () => {
    const ctx = makeCtx()
    // getTokens (refresh) result:
    ctx.http.post
      .mockRejectedValueOnce({ response: { status: 401 } }) // first createWebhook call
      .mockResolvedValueOnce({ access_token: 'AT2', refresh_token: 'RT2' }) // refresh getTokens
      .mockResolvedValueOnce({ id: 99 }) // retried createWebhook
    const http = new GitHubHttp(ctx, config)
    const u = user()
    const out = await http.createWebhook(u, 'org/repo', { secret: 's', callbackUrl: 'cb' })
    expect(out).toEqual({ id: 99 })
    // refresh persisted to db + mutated the in-memory user
    expect(ctx.database.set).toHaveBeenCalledWith('user', { id: 7 }, {
      'github.accessToken': 'AT2', 'github.refreshToken': 'RT2',
    })
    expect(u.github.accessToken).toBe('AT2')
    // retried with the new token
    expect(ctx.http.post).toHaveBeenLastCalledWith(
      'https://api.github.com/repos/org/repo/hooks',
      expect.anything(),
      { headers: { authorization: 'token AT2', accept: 'application/vnd.github.v3+json' } }
    )
  })

  it('non-401 errors propagate', async () => {
    const ctx = makeCtx()
    ctx.http.post.mockRejectedValue({ response: { status: 404 } })
    const http = new GitHubHttp(ctx, config)
    await expect(http.createWebhook(user(), 'org/repo', { secret: 's', callbackUrl: 'cb' }))
      .rejects.toMatchObject({ response: { status: 404 } })
  })
})

describe('deleteWebhook', () => {
  it('DELETEs /repos/{repo}/hooks/{id} with auth header', async () => {
    const ctx = makeCtx()
    ctx.http.delete.mockResolvedValue(undefined)
    const http = new GitHubHttp(ctx, config)
    await http.deleteWebhook(user(), 'org/repo', 42)
    expect(ctx.http.delete).toHaveBeenCalledWith(
      'https://api.github.com/repos/org/repo/hooks/42',
      { headers: { authorization: 'token at0', accept: 'application/vnd.github.v3+json' } }
    )
  })
  it('swallows a 404 (hook already gone)', async () => {
    const ctx = makeCtx()
    ctx.http.delete.mockRejectedValue({ response: { status: 404 } })
    const http = new GitHubHttp(ctx, config)
    await expect(http.deleteWebhook(user(), 'org/repo', 42)).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/plugins/github/__tests__/http.test.ts`
Expected: FAIL（`Cannot find module '../http'`）。

- [ ] **Step 3: 写实现**

先加类型。在 `src/plugins/github/types.ts` 追加：
```ts
/** OAuth token pair as returned by GitHub's access_token endpoint. */
export interface OAuthTokens {
  access_token: string
  refresh_token: string
}

/** The subset of a koishi user this plugin reads/writes (userFields(['id','github'])). */
export interface GitHubUser {
  id: number
  github: { accessToken: string; refreshToken: string }
}
```

Create `src/plugins/github/http.ts`:
```ts
import type { Context } from 'koishi'
import type { Config, OAuthTokens, GitHubUser } from './types'

const API = 'https://api.github.com'
const authHeaders = (token: string) => ({
  authorization: `token ${token}`,
  accept: 'application/vnd.github.v3+json',
})

/** ctx.http (Quester) wrapper for GitHub REST + OAuth. No octokit (Phase 3 decision A). */
export class GitHubHttp {
  constructor(private ctx: Context, private config: Config) {}

  /** Exchange an OAuth code (or refresh_token) for tokens. Params go on the query string. */
  getTokens(params: Record<string, any>): Promise<OAuthTokens> {
    return this.ctx.http.post('https://github.com/login/oauth/access_token', {}, {
      params: { client_id: this.config.appId, client_secret: this.config.appSecret, ...params },
      headers: { accept: 'application/json' },
    })
  }

  /** Run an authed call; on 401 refresh the user's token, persist it, and retry once. */
  private async withAuth<T>(user: GitHubUser, fn: (token: string) => Promise<T>): Promise<T> {
    try {
      return await fn(user.github.accessToken)
    } catch (e: any) {
      if (e?.response?.status !== 401) throw e
      const t = await this.getTokens({
        refresh_token: user.github.refreshToken,
        grant_type: 'refresh_token',
      })
      await this.ctx.database.set('user', { id: user.id }, {
        'github.accessToken': t.access_token,
        'github.refreshToken': t.refresh_token,
      })
      user.github.accessToken = t.access_token
      user.github.refreshToken = t.refresh_token
      return await fn(t.access_token)
    }
  }

  createWebhook(
    user: GitHubUser,
    repo: string,
    opts: { secret: string; callbackUrl: string }
  ): Promise<{ id: number }> {
    return this.withAuth(user, (token) =>
      this.ctx.http.post(
        `${API}/repos/${repo}/hooks`,
        { events: ['*'], config: { url: opts.callbackUrl, secret: opts.secret } },
        { headers: authHeaders(token) }
      )
    )
  }

  async deleteWebhook(user: GitHubUser, repo: string, hookId: number): Promise<void> {
    try {
      await this.withAuth(user, (token) =>
        this.ctx.http.delete(`${API}/repos/${repo}/hooks/${hookId}`, { headers: authHeaders(token) })
      )
    } catch (e: any) {
      if (e?.response?.status === 404) return // hook already gone
      throw e
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/plugins/github/__tests__/http.test.ts`
Expected: PASS（getTokens + createWebhook 正常/401refresh/非401传播 + deleteWebhook 正常/404吞掉）。

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit -p .`
Expected: `src/plugins/github` 下无新错误（仓库既有的无关 tsc 报错忽略）。

- [ ] **Step 6: Commit**

```bash
git add src/plugins/github/http.ts src/plugins/github/__tests__/http.test.ts src/plugins/github/types.ts
git commit -m "feat(github): GitHubHttp ctx.http layer (token exchange, 401 refresh, webhook CRUD)"
```

---

### Task 2: OAuth — 纯回调状态机 + authorize 命令 + 回调路由

**Files:**
- Create: `src/plugins/github/oauth.ts`
- Create: `src/plugins/github/__tests__/oauth.test.ts`

参考：research §1a（authorize 命令）、§1b（回调路由 + 校验顺序 400/403/200）。

**Interfaces:**
- Consumes: `GitHubHttp`（Task 1）
- Produces:
  - `interface OAuthCallbackDeps { consumeState(state: string): number | undefined; exchangeCode(code: string, state: string): Promise<OAuthTokens>; storeTokens(userId: number, tokens: OAuthTokens): Promise<void> }`
  - `handleOAuthCallback(query: Record<string, any>, deps: OAuthCallbackDeps): Promise<number>`（返回 HTTP 状态码）
  - `applyOAuth(ctx: Context, config: Config, http: GitHubHttp): void`（注册 `github.authorize`/`.auth` 命令 + `GET {path}/authorize` 路由）
  - `buildAuthorizeUrl(config: Config, state: string): string`（供命令与测试复用）

- [ ] **Step 1: 写失败测试**

Create `src/plugins/github/__tests__/oauth.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { handleOAuthCallback, buildAuthorizeUrl } from '../oauth'

describe('handleOAuthCallback', () => {
  const tokens = { access_token: 'AT', refresh_token: 'RT' }
  const makeDeps = () => ({
    consumeState: vi.fn((s: string) => (s === 'good' ? 7 : undefined)),
    exchangeCode: vi.fn().mockResolvedValue(tokens),
    storeTokens: vi.fn().mockResolvedValue(undefined),
  })

  it('400 when state is missing', async () => {
    const deps = makeDeps()
    expect(await handleOAuthCallback({ code: 'c' }, deps)).toBe(400)
    expect(deps.exchangeCode).not.toHaveBeenCalled()
  })
  it('400 when state is an array (duplicate query param)', async () => {
    expect(await handleOAuthCallback({ state: ['a', 'b'], code: 'c' }, makeDeps())).toBe(400)
  })
  it('403 when state is unknown', async () => {
    const deps = makeDeps()
    expect(await handleOAuthCallback({ state: 'bad', code: 'c' }, deps)).toBe(403)
    expect(deps.exchangeCode).not.toHaveBeenCalled()
  })
  it('200 exchanges the code and stores tokens for the mapped user', async () => {
    const deps = makeDeps()
    expect(await handleOAuthCallback({ state: 'good', code: 'CODE' }, deps)).toBe(200)
    expect(deps.exchangeCode).toHaveBeenCalledWith('CODE', 'good')
    expect(deps.storeTokens).toHaveBeenCalledWith(7, tokens)
  })
})

describe('buildAuthorizeUrl', () => {
  it('includes client_id, state, redirect_uri, and the repo-hook scope', () => {
    const url = buildAuthorizeUrl({ appId: 'CID', redirect: 'https://sili.example/api/github/authorize' } as any, 'ST')
    expect(url).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/)
    const q = new URL(url).searchParams
    expect(q.get('client_id')).toBe('CID')
    expect(q.get('state')).toBe('ST')
    expect(q.get('redirect_uri')).toBe('https://sili.example/api/github/authorize')
    expect(q.get('scope')).toBe('admin:repo_hook,repo')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/plugins/github/__tests__/oauth.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

Create `src/plugins/github/oauth.ts`:
```ts
import { Context, Random } from 'koishi'
import type { Config, OAuthTokens } from './types'
import type { GitHubHttp } from './http'

const sanitize = (p: string) => (p.endsWith('/') ? p.slice(0, -1) : p)

/** Build the GitHub OAuth authorize URL (1:1 with the old plugin: scope admin:repo_hook,repo). */
export function buildAuthorizeUrl(config: Config, state: string): string {
  const params = new URLSearchParams({
    state,
    client_id: config.appId ?? '',
    redirect_uri: config.redirect ?? '',
    scope: 'admin:repo_hook,repo',
  })
  return 'https://github.com/login/oauth/authorize?' + params.toString()
}

export interface OAuthCallbackDeps {
  /** Return the koishi user id for a state token and consume (delete) it; undefined if unknown. */
  consumeState(state: string): number | undefined
  exchangeCode(code: string, state: string): Promise<OAuthTokens>
  storeTokens(userId: number, tokens: OAuthTokens): Promise<void>
}

/** Pure OAuth callback core. Status order mirrors the old plugin: 400 bad state, 403 unknown, 200 ok. */
export async function handleOAuthCallback(
  query: Record<string, any>,
  deps: OAuthCallbackDeps
): Promise<number> {
  const state = query.state
  if (!state || Array.isArray(state)) return 400
  const userId = deps.consumeState(String(state))
  if (userId === undefined) return 403
  const tokens = await deps.exchangeCode(String(query.code), String(state))
  await deps.storeTokens(userId, tokens)
  return 200
}

/** Register the authorize command + OAuth callback route. */
export function applyOAuth(ctx: Context, config: Config, http: GitHubHttp): void {
  const path = sanitize(config.path ?? '/github')
  const states: Record<string, number> = Object.create(null) // state token -> koishi user id

  ctx.command('github.authorize')
    .alias('github.auth')
    .userFields(['id'])
    .action(({ session }) => {
      const state = Random.id()
      states[state] = session!.user!.id
      // '.follow-link' in the old locale = '请点击下面的链接继续操作：'
      return '请点击下面的链接继续操作：\n' + buildAuthorizeUrl(config, state)
    })

  ctx.server.get(path + '/authorize', async (koa) => {
    koa.status = await handleOAuthCallback(koa.query, {
      consumeState: (s) => {
        const id = states[s]
        if (id === undefined) return undefined
        delete states[s]
        return id
      },
      exchangeCode: (code, state) => http.getTokens({ code, state, redirect_uri: config.redirect }),
      storeTokens: (id, t) =>
        ctx.database.set('user', { id }, {
          'github.accessToken': t.access_token,
          'github.refreshToken': t.refresh_token,
        }),
    })
  })
}
```

> 注：`states` map 为进程内内存（与旧插件一致）。OAuth 流程秒级完成，重启丢失可接受——用户重跑 `github.authorize` 即可。**实施者：`ctx.server.get` 回调参数对象名/`koa.query`/`koa.status` 的确切形状请对照 webhook.ts:63 的 `ctx.server.post`（同一 server 服务）确认。**

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/plugins/github/__tests__/oauth.test.ts`
Expected: PASS（400/400-array/403/200 + buildAuthorizeUrl 各字段）。

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit -p .`
Expected: `src/plugins/github` 下无新错误。

- [ ] **Step 6: Commit**

```bash
git add src/plugins/github/oauth.ts src/plugins/github/__tests__/oauth.test.ts
git commit -m "feat(github): OAuth callback core + authorize command + callback route"
```

---

### Task 3: 订阅决策纯核 + `github`/`gh` 命令（-l / -a / -d）

**Files:**
- Create: `src/plugins/github/commands.ts`
- Create: `src/plugins/github/__tests__/commands-subscribe.test.ts`

参考：research §1c（github/gh 命令逐条行为 + 回复 key）、§1f（filter meta = `{}`）。回复串以 `node_modules/koishi-plugin-github/lib/locales/zh-CN.json` 为准。

**Interfaces:**
- Consumes: `SubscriptionStore`（`subscribe.ts`）、`GitHubHttp`（Task 1）
- Produces（本 task 只做订阅侧，`github.repos` 在 Task 4，同一文件）：
  - `export const REPO_RE = /^[\w.-]+\/[\w.-]+$/`
  - `export const MSG`（回复串常量对象，逐字取自 locale JSON；本 task 用到的 key 见下）
  - `resolveListReply(webhooks: Record<string, unknown> | undefined): string`（纯：-l 的回复文本）
  - `applyCommands(ctx, config, http, store, repoStore)`（注册命令；本 task 先建骨架 + `github`/`gh`；Task 4 往里加 `github.repos`）—— 其中 `repoStore` 见下方 RepoStore 说明
  - `interface RepoStore { has(name: string): Promise<boolean>; get(name: string): Promise<{ id: number; secret: string } | undefined>; create(row: { id: number; name: string; secret: string }): Promise<void>; remove(name: string): Promise<void>; list(): Promise<string[]> }`（对 `github` 表的最小封装，便于纯测 + Task 4 复用；实现用 `ctx.database`）

> **为何要 `RepoStore` / 决策纯核**：命令 `.action` 深耦合 koishi session，本仓库无 app 测试框架。把「给定状态→回复 key + 副作用」的决策抽成注入依赖的纯函数即可单测；session/`$update`/`prompt` 是薄胶水，tsc + 真机冒烟兜底。

- [ ] **Step 1: 写失败测试（纯核）**

Create `src/plugins/github/__tests__/commands-subscribe.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { REPO_RE, resolveListReply, MSG } from '../commands'

describe('REPO_RE', () => {
  it('accepts owner/repo with word chars, dot, hyphen', () => {
    expect(REPO_RE.test('dragon-fish/sili.bot')).toBe(true)
  })
  it('rejects names without a single slash', () => {
    expect(REPO_RE.test('nope')).toBe(false)
    expect(REPO_RE.test('a/b/c')).toBe(false)
  })
})

describe('resolveListReply', () => {
  it('lists subscribed repo names sorted, one per line', () => {
    expect(resolveListReply({ 'b/b': {}, 'a/a': {} })).toBe('a/a\nb/b')
  })
  it('returns the empty message when there are no subscriptions', () => {
    expect(resolveListReply({})).toBe(MSG.listEmpty)
    expect(resolveListReply(undefined)).toBe(MSG.listEmpty)
  })
})

describe('MSG (verbatim from old locale zh-CN.json)', () => {
  it('carries the exact reply strings', () => {
    expect(MSG.listEmpty).toBe('当前没有订阅的仓库。')
    expect(MSG.privateContext).toBe('当前不是群聊上下文。')
    expect(MSG.repoExpected).toBe('请输入仓库名。')
    expect(MSG.repoInvalid).toBe('请输入正确的仓库名。')
    expect(MSG.subAddUnchanged('a/b')).toBe('已经在当前频道订阅过仓库 a/b。')
    expect(MSG.subAddSucceeded).toBe('添加订阅成功！')
    expect(MSG.subDeleteUnchanged('a/b')).toBe('尚未在当前频道订阅过仓库 a/b。')
    expect(MSG.subDeleteSucceeded).toBe('移除订阅成功！')
    expect(MSG.subUnknown('a/b')).toBe('尚未添加过仓库 a/b。发送空行或句号以立即添加并订阅该仓库。')
  })
})
```

> **实施者必做**：打开 `node_modules/koishi-plugin-github/lib/locales/zh-CN.json`，逐一核对上面每个串**逐字一致**（含标点、全角句号 `。`、感叹号 `！`）。若本计划抄录有出入，**以 JSON 为准**并同步修正测试。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/plugins/github/__tests__/commands-subscribe.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

Create `src/plugins/github/commands.ts`:
```ts
import { Context, Random } from 'koishi'
import type { Config } from './types'
import type { GitHubHttp } from './http'
import type { SubscriptionStore } from './subscribe'

export const REPO_RE = /^[\w.-]+\/[\w.-]+$/

/** Reply strings — verbatim from the old plugin's locales/zh-CN.json. Functions interpolate the repo name. */
export const MSG = {
  followLink: '请点击下面的链接继续操作：',
  listEmpty: '当前没有订阅的仓库。',
  privateContext: '当前不是群聊上下文。',
  repoExpected: '请输入仓库名。',
  repoInvalid: '请输入正确的仓库名。',
  reposEmpty: '当前没有监听的仓库。',
  subAddUnchanged: (n: string) => `已经在当前频道订阅过仓库 ${n}。`,
  subAddSucceeded: '添加订阅成功！',
  subDeleteUnchanged: (n: string) => `尚未在当前频道订阅过仓库 ${n}。`,
  subDeleteSucceeded: '移除订阅成功！',
  subUnknown: (n: string) => `尚未添加过仓库 ${n}。发送空行或句号以立即添加并订阅该仓库。`,
  repoAddUnchanged: (n: string) => `已经添加过仓库 ${n}。`,
  repoAddSucceeded: '添加仓库成功！',
  repoAddFailed: '由于未知原因添加仓库失败。',
  repoNotFound: '仓库不存在或您无权访问。',
  repoDeleteUnchanged: (n: string) => `尚未添加过仓库 ${n}。`,
  repoDeleteSucceeded: '移除仓库成功！',
} as const

/** Pure: the -l list reply. */
export function resolveListReply(webhooks: Record<string, unknown> | undefined): string {
  const names = Object.keys(webhooks ?? {})
  return names.length ? names.sort().join('\n') : MSG.listEmpty
}

/** Minimal wrapper over the `github` table (hook registry). */
export interface RepoStore {
  has(name: string): Promise<boolean>
  get(name: string): Promise<{ id: number; secret: string } | undefined>
  create(row: { id: number; name: string; secret: string }): Promise<void>
  remove(name: string): Promise<void>
  list(): Promise<string[]>
}

export function makeRepoStore(ctx: Context): RepoStore {
  return {
    async has(name) {
      return (await ctx.database.get('github', { name: [name] })).length > 0
    },
    async get(name) {
      const [row] = await ctx.database.get('github', { name: [name] })
      return row ? { id: row.id, secret: row.secret } : undefined
    },
    async create(row) {
      await ctx.database.create('github', row)
    },
    async remove(name) {
      await ctx.database.remove('github', { name: [name] })
    },
    async list() {
      return (await ctx.database.get('github', {})).map((r) => r.name)
    },
  }
}

/** Register github/gh + github.repos. (github.repos body is added in Task 4.) */
export function applyCommands(
  ctx: Context,
  config: Config,
  http: GitHubHttp,
  store: SubscriptionStore,
  repoStore: RepoStore
): void {
  const hidden = (session: any) => session.isDirect

  // ---- github [name] / gh : channel subscription management ----
  ctx.command('github [name]')
    .alias('gh')
    .channelFields(['github'])
    .option('list', '-l', { hidden })
    .option('add', '-a', { hidden, authority: 2 })
    .option('delete', '-d', { hidden, authority: 2 })
    .action(async ({ session, options }, name) => {
      const s = session!
      if (options!.list) {
        if (!s.channel) return MSG.privateContext
        return resolveListReply(s.channel.github.webhooks)
      }
      if (options!.add || options!.delete) {
        if (!s.channel) return MSG.privateContext
        if (!name) return MSG.repoExpected
        if (!REPO_RE.test(name)) return MSG.repoInvalid
        const repo = name.toLowerCase()
        const webhooks = s.channel.github.webhooks

        if (options!.delete) {
          if (!(repo in webhooks)) return MSG.subDeleteUnchanged(repo)
          delete webhooks[repo]
          await s.channel.$update()
          store.unsubscribe(repo, s.cid)
          return MSG.subDeleteSucceeded
        }

        // -a (subscribe)
        if (repo in webhooks) return MSG.subAddUnchanged(repo)
        if (!(await repoStore.has(repo))) {
          // Not registered yet: offer the one-shot "send empty line to add" flow.
          await s.send(MSG.subUnknown(repo))
          const reply = await s.prompt(config.replyTimeout ?? 60000)
          if (reply !== undefined && ['', '.', '。'].includes(reply.trim())) {
            // Chain into github.repos --add --subscribe (creates hook AND subscribes).
            return s.execute({ name: 'github.repos', args: [repo], options: { add: true, subscribe: true } }, true)
          }
          return
        }
        webhooks[repo] = {}
        await s.channel.$update()
        store.subscribe(repo, s.cid, {})
        return MSG.subAddSucceeded
      }
      return s.execute('help github')
    })

  // github.repos is registered in Task 4 (same applyCommands function).
  applyReposCommand(ctx, config, http, store, repoStore)
}

// Placeholder to be implemented in Task 4 (declared here so applyCommands compiles standalone
// is NOT desired — Task 4 will define it in this same file and remove this stub).
function applyReposCommand(
  _ctx: Context, _config: Config, _http: GitHubHttp,
  _store: SubscriptionStore, _repoStore: RepoStore
): void {}
```

> **实施者注意**：`s.channel.github.webhooks` 在 koishi observed 对象上直接改字段后需 `await s.channel.$update()` 落库（先例 mediawiki/index.ts:357）。`s.cid` = `${platform}:${channelId}`。`s.execute(argv, true)` 第二参 `true` = 静默执行子命令（先例 pixiv/dice）。上面 `applyReposCommand` 是**临时空桩**，Task 4 用真实实现替换（不要保留空桩）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/plugins/github/__tests__/commands-subscribe.test.ts`
Expected: PASS（REPO_RE + resolveListReply + MSG 逐字）。

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit -p .`
Expected: `src/plugins/github` 下无新错误（`github`/`gh` 命令的 session/channel 类型解析正常；若 `s.channel.github` 类型不认，确认 `channelFields(['github'])` 已声明且 model.extend 的 `channel.github` 类型增强生效）。

- [ ] **Step 6: Commit**

```bash
git add src/plugins/github/commands.ts src/plugins/github/__tests__/commands-subscribe.test.ts
git commit -m "feat(github): subscribe decision core + github/gh channel commands (-l/-a/-d)"
```

---

### Task 4: `github.repos` 命令（-a / -d / -s）+ webhook 生命周期

**Files:**
- Modify: `src/plugins/github/commands.ts`（用真实 `applyReposCommand` 替换 Task 3 的空桩）
- Create: `src/plugins/github/__tests__/commands-repos.test.ts`

参考：research §1d（github.repos 逐条 + 建/删 hook + DB 写 + `-s` 链式 + 错误码映射）。

**Interfaces:**
- Consumes: `GitHubHttp.createWebhook/deleteWebhook`（Task 1）、`RepoStore`（Task 3）、`MSG`/`REPO_RE`（Task 3）、`SubscriptionStore`
- Produces:
  - `resolveReposListReply(names: string[]): string`（纯：无 option 时列出所有已监听仓库）
  - `mapWebhookError(status: number | undefined): 'notFound' | 'failed'`（纯：GitHub 建 hook 报错码 → 回复 key；404→notFound，其它→failed）
  - 真实 `applyReposCommand(ctx, config, http, store, repoStore)`

- [ ] **Step 1: 写失败测试（纯核）**

Create `src/plugins/github/__tests__/commands-repos.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveReposListReply, mapWebhookError, MSG } from '../commands'

describe('resolveReposListReply', () => {
  it('joins registered repo names by newline', () => {
    expect(resolveReposListReply(['a/a', 'b/b'])).toBe('a/a\nb/b')
  })
  it('returns the empty message when none are registered', () => {
    expect(resolveReposListReply([])).toBe(MSG.reposEmpty)
  })
})

describe('mapWebhookError', () => {
  it('maps 404 to notFound', () => {
    expect(mapWebhookError(404)).toBe('notFound')
  })
  it('maps anything else to failed', () => {
    expect(mapWebhookError(403)).toBe('failed')
    expect(mapWebhookError(500)).toBe('failed')
    expect(mapWebhookError(undefined)).toBe('failed')
  })
})

describe('MSG repos strings (verbatim from old locale)', () => {
  it('exact', () => {
    expect(MSG.reposEmpty).toBe('当前没有监听的仓库。')
    expect(MSG.repoAddUnchanged('a/b')).toBe('已经添加过仓库 a/b。')
    expect(MSG.repoAddSucceeded).toBe('添加仓库成功！')
    expect(MSG.repoAddFailed).toBe('由于未知原因添加仓库失败。')
    expect(MSG.repoNotFound).toBe('仓库不存在或您无权访问。')
    expect(MSG.repoDeleteUnchanged('a/b')).toBe('尚未添加过仓库 a/b。')
    expect(MSG.repoDeleteSucceeded).toBe('移除仓库成功！')
  })
})
```

> **实施者必做**：同 Task 3，对照 `locales/zh-CN.json` 逐字核对；以 JSON 为准。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/plugins/github/__tests__/commands-repos.test.ts`
Expected: FAIL（`resolveReposListReply`/`mapWebhookError` 未导出）。

- [ ] **Step 3: 写实现**

在 `src/plugins/github/commands.ts`：加两个纯函数（放 `resolveListReply` 附近）：
```ts
/** Pure: the no-option github.repos reply (list all registered repos). */
export function resolveReposListReply(names: string[]): string {
  return names.length ? names.join('\n') : MSG.reposEmpty
}

/** Pure: map a GitHub webhook-create error status to a reply key. */
export function mapWebhookError(status: number | undefined): 'notFound' | 'failed' {
  return status === 404 ? 'notFound' : 'failed'
}
```

然后把 Task 3 里的空桩 `applyReposCommand` 替换为：
```ts
function applyReposCommand(
  ctx: Context,
  config: Config,
  http: GitHubHttp,
  store: SubscriptionStore,
  repoStore: RepoStore
): void {
  const path = (config.path ?? '/github').replace(/\/$/, '')
  const callbackUrl = () => ctx.server.config.selfUrl + path + '/webhook'

  ctx.command('github.repos [name]')
    .userFields(['id', 'github'])
    .option('add', '-a')
    .option('delete', '-d')
    .option('subscribe', '-s')
    .action(async ({ session, options }, name) => {
      const s = session!
      if (!options!.add && !options!.delete) {
        return resolveReposListReply(await repoStore.list())
      }
      // shared guards for -a / -d
      if (!name) return MSG.repoExpected
      if (!REPO_RE.test(name)) return MSG.repoInvalid
      if (!s.user!.github?.accessToken) {
        // require-auth: '要使用此功能，请对机器人进行授权。输入你的 GitHub 用户名。'
        await s.send('要使用此功能，请对机器人进行授权。输入你的 GitHub 用户名。')
        return s.execute({ name: 'github.authorize' })
      }
      const repo = name.toLowerCase()
      const user = { id: s.user!.id, github: s.user!.github }

      if (options!.add) {
        if (await repoStore.has(repo)) return MSG.repoAddUnchanged(repo)
        const secret = Random.id()
        let data: { id: number }
        try {
          data = await http.createWebhook(user, repo, { secret, callbackUrl: callbackUrl() })
        } catch (e: any) {
          const key = mapWebhookError(e?.response?.status)
          if (key === 'notFound') return MSG.repoNotFound
          ctx.logger('github').warn(e)
          return MSG.repoAddFailed
        }
        await repoStore.create({ name: repo, id: data.id, secret })
        if (!options!.subscribe) return MSG.repoAddSucceeded
        // -s: chain into channel subscribe (github --add)
        return s.execute({ name: 'github', args: [repo], options: { add: true } }, true)
      }

      // -d (delete webhook globally)
      const row = await repoStore.get(repo)
      if (!row) return MSG.repoDeleteUnchanged(repo)
      await http.deleteWebhook(user, repo, row.id) // swallows 404 internally
      // remove the repo key from every channel's webhooks + drop the whole-repo subscription
      const channels = await ctx.database.get('channel', {}, ['id', 'platform', 'github'])
      await ctx.database.upsert(
        'channel',
        channels.filter(({ github }) => github?.webhooks?.[repo]).map((c) => {
          delete c.github.webhooks[repo]
          return c
        })
      )
      store.unsubscribe(repo)
      await repoStore.remove(repo)
      return MSG.repoDeleteSucceeded
    })
}
```

> 说明：`-s` 走 `s.execute({name:'github', options:{add:true}}, true)` 链入 Task 3 的频道订阅路径（1:1 旧 command.js:93-97）。`require-auth` 串同样以 locale JSON 为准。`ctx.logger('github')` 为 koishi logger（先例仓库内多处）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/plugins/github/__tests__/commands-repos.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量 github 测试 + 类型检查**

Run: `npx vitest run src/plugins/github`
Expected: 全绿（Phase 1/2 + http + oauth + 两个 commands 测试）。
Run: `npx tsc --noEmit -p .`
Expected: `src/plugins/github` 下无新错误。

- [ ] **Step 6: Commit**

```bash
git add src/plugins/github/commands.ts src/plugins/github/__tests__/commands-repos.test.ts
git commit -m "feat(github): github.repos command (webhook create/delete/subscribe)"
```

---

### Task 5: 仓库改名迁移（纯核 + webhook.ts 接线）

**Files:**
- Create: `src/plugins/github/rename.ts`
- Create: `src/plugins/github/__tests__/rename.test.ts`
- Modify: `src/plugins/github/webhook.ts`（`WebhookDeps.getSecret` → `getHook`；改名检测）
- Modify: `src/plugins/github/__tests__/webhook.test.ts` + `src/plugins/github/__tests__/webhook-dispatch.test.ts`（更新 deps stub 到 `getHook`）

参考：research §1e（改名迁移逻辑 + 检测点）。

**Interfaces:**
- Consumes: `SubscriptionStore`
- Produces:
  - `interface RenameDeps { setHookName(hookId: number, newName: string, secret: string): Promise<void>; getChannels(): Promise<Array<{ id: string; platform: string; github: { webhooks: Record<string, any> } }>>; upsertChannels(rows: any[]): Promise<void> }`
  - `migrateRepoRename(hookId: number, oldName: string, newName: string, secret: string, store: SubscriptionStore, deps: RenameDeps): Promise<void>`
- Changes `WebhookDeps`：`getSecret(hookId): Promise<string|undefined>` → `getHook(hookId): Promise<{ name: string; secret: string } | undefined>`；新增可选 `onRename?(hookId, oldName, newName, secret): Promise<void>`。

- [ ] **Step 1: 写 rename 失败测试**

Create `src/plugins/github/__tests__/rename.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { migrateRepoRename } from '../rename'
import { SubscriptionStore } from '../subscribe'

describe('migrateRepoRename', () => {
  it('renames the hook row, re-keys each channel webhooks map, and swaps the store index', async () => {
    const store = new SubscriptionStore()
    store.subscribe('old/name', 'qq:1', { push: true })
    store.subscribe('old/name', 'qq:2', {})

    const channels = [
      { id: '1', platform: 'qq', github: { webhooks: { 'old/name': { push: true }, 'x/y': {} } } },
      { id: '2', platform: 'qq', github: { webhooks: { 'old/name': {} } } },
      { id: '3', platform: 'qq', github: { webhooks: { 'z/z': {} } } }, // unrelated, untouched
    ]
    const deps = {
      setHookName: vi.fn().mockResolvedValue(undefined),
      getChannels: vi.fn().mockResolvedValue(channels),
      upsertChannels: vi.fn().mockResolvedValue(undefined),
    }

    await migrateRepoRename(999, 'old/name', 'new/name', 'sek', store, deps)

    // hook row updated (keep secret)
    expect(deps.setHookName).toHaveBeenCalledWith(999, 'new/name', 'sek')
    // only the two channels that had old/name are upserted, re-keyed to new/name
    const upserted = deps.upsertChannels.mock.calls[0][0]
    expect(upserted.map((c: any) => c.id).sort()).toEqual(['1', '2'])
    expect(upserted.find((c: any) => c.id === '1').github.webhooks).toEqual({ 'new/name': { push: true }, 'x/y': {} })
    expect(upserted.find((c: any) => c.id === '2').github.webhooks).toEqual({ 'new/name': {} })
    // store: old gone, new present with per-channel meta preserved
    expect(store.targets('old/name', 'push')).toEqual([])
    expect(store.targets('new/name', 'push').sort()).toEqual(['qq:1', 'qq:2'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/plugins/github/__tests__/rename.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写 rename 实现**

Create `src/plugins/github/rename.ts`:
```ts
import type { SubscriptionStore } from './subscribe'

export interface RenameDeps {
  /** Update the github row's name (keep the same secret). */
  setHookName(hookId: number, newName: string, secret: string): Promise<void>
  getChannels(): Promise<
    Array<{ id: string; platform: string; github: { webhooks: Record<string, any> } }>
  >
  upsertChannels(rows: any[]): Promise<void>
}

/**
 * Migrate a repo rename (1:1 with old command.js:273-288): rename the hook row, move the
 * webhooks meta key old->new in every subscribed channel, and swap the in-memory index.
 */
export async function migrateRepoRename(
  hookId: number,
  oldName: string,
  newName: string,
  secret: string,
  store: SubscriptionStore,
  deps: RenameDeps
): Promise<void> {
  await deps.setHookName(hookId, newName, secret)
  store.unsubscribe(oldName) // drop the whole old-repo index
  const channels = await deps.getChannels()
  const affected = channels.filter((c) => c.github?.webhooks?.[oldName])
  for (const c of affected) {
    const meta = c.github.webhooks[oldName]
    c.github.webhooks[newName] = meta
    delete c.github.webhooks[oldName]
    store.subscribe(newName, `${c.platform}:${c.id}`, meta)
  }
  if (affected.length) await deps.upsertChannels(affected)
}
```

- [ ] **Step 4: 跑 rename 测试确认通过**

Run: `npx vitest run src/plugins/github/__tests__/rename.test.ts`
Expected: PASS。

- [ ] **Step 5: 改 webhook.ts —— getSecret → getHook + 改名检测**

在 `src/plugins/github/webhook.ts`：
1. `WebhookDeps` 改为：
```ts
export interface WebhookDeps {
  /** Look up a webhook's stored repo name + secret by its GitHub hook id. */
  getHook(hookId: number): Promise<{ name: string; secret: string } | undefined>
  /** Resolve subscribed cids for a repo + event (+ action). */
  targets(repo: string, event: string, action?: string): string[]
  /** Migrate subscriptions when the repo was renamed (optional; no-op if absent). */
  onRename?(hookId: number, oldName: string, newName: string, secret: string): Promise<void>
}
```
2. `handleWebhook` 内，把
```ts
  const secret = await deps.getSecret(hookId)
  if (!secret) return { status: 202 } // unknown hook: repos -a probe window

  if (!(await isSignatureValid(secret, rawBody, signature))) return { status: 403 }

  const repo = payload.repository.full_name.toLowerCase()
```
改为
```ts
  const hook = await deps.getHook(hookId)
  if (!hook) return { status: 202 } // unknown hook: repos -a probe window

  if (!(await isSignatureValid(hook.secret, rawBody, signature))) return { status: 403 }

  const repo = payload.repository.full_name.toLowerCase()
  // Repo rename: the stored name no longer matches the incoming full_name. Migrate before
  // resolving targets so the (renamed) subscription index is used. Only after a valid signature.
  if (hook.name !== repo && deps.onRename) {
    await deps.onRename(hookId, hook.name, repo, hook.secret)
  }
```

- [ ] **Step 6: 更新既有 webhook 测试 stub（getSecret → getHook）**

在 `src/plugins/github/__tests__/webhook.test.ts` 与 `webhook-dispatch.test.ts` 中，把 deps 里的
`getSecret: async () => secret`（或类似）改为
`getHook: async () => ({ name: '<对应仓库lowercase>', secret })`
—— name 用该测试 payload 的 `repository.full_name.toLowerCase()`（保持与 payload 一致，避免误触发改名分支）。**逐个测试用例核对：其 payload repo 名 = stub 的 hook.name。** 不新增 `onRename`（缺省即不迁移，行为不变）。

- [ ] **Step 7: 全量 github 测试 + 类型检查**

Run: `npx vitest run src/plugins/github`
Expected: 全绿（rename 新测试 + 既有 webhook/dispatch 测试改 stub 后仍通过）。
Run: `npx tsc --noEmit -p .`
Expected: `src/plugins/github` 下无新错误。

- [ ] **Step 8: Commit**

```bash
git add src/plugins/github/rename.ts src/plugins/github/__tests__/rename.test.ts src/plugins/github/webhook.ts src/plugins/github/__tests__/webhook.test.ts src/plugins/github/__tests__/webhook-dispatch.test.ts
git commit -m "feat(github): repo-rename migration + webhook getHook dep"
```

---

### Task 6: 插件入口接线 + 注册 redirect env + 收口

**Files:**
- Modify: `src/plugins/github/index.ts`（inject 加 `'http'`；构造 http/oauth/commands；webhook deps 换 getHook + onRename）
- Modify: `src/index.ts`（注册时传 `redirect: env.TOKEN_GITHUB_REDIRECT`）
- Create: `.debug/github-plugin/phase3-smoke-checklist.md`（真机冒烟清单，供部署后人工验证；置于 gitignore 的 .debug）

参考：research §4（Config/注册/env）。

**Interfaces:**
- Consumes: `GitHubHttp`、`applyOAuth`、`applyCommands`+`makeRepoStore`、`migrateRepoRename`+`RenameDeps`

- [ ] **Step 1: 改 index.ts 接线**

在 `src/plugins/github/index.ts`：
1. `static inject = ['database', 'server']` → `static inject = ['database', 'server', 'http']`。
2. import 新模块：
```ts
import { GitHubHttp } from './http'
import { applyOAuth } from './oauth'
import { applyCommands, makeRepoStore } from './commands'
import { migrateRepoRename } from './rename'
```
3. 构造 http + oauth + commands，并把 webhook deps 换成 `getHook` + `onRename`。把现有
```ts
    applyWebhook(ctx, this.config, {
      getSecret: async (hookId) => (await ctx.database.get('github', [hookId]))[0]?.secret,
      targets: (repo, event, action) => this.store.targets(repo, event, action),
    })
```
替换为
```ts
    const http = new GitHubHttp(ctx, this.config)
    const repoStore = makeRepoStore(ctx)

    applyOAuth(ctx, this.config, http)
    applyCommands(ctx, this.config, http, this.store, repoStore)

    applyWebhook(ctx, this.config, {
      getHook: async (hookId) => {
        const [row] = await ctx.database.get('github', [hookId])
        return row ? { name: row.name, secret: row.secret } : undefined
      },
      targets: (repo, event, action) => this.store.targets(repo, event, action),
      onRename: (hookId, oldName, newName, secret) =>
        migrateRepoRename(hookId, oldName, newName, secret, this.store, {
          setHookName: (id, name, sec) => ctx.database.set('github', id, { name, secret: sec }),
          getChannels: () => ctx.database.get('channel', {}, ['id', 'platform', 'github']) as any,
          upsertChannels: (rows) => ctx.database.upsert('channel', rows),
        }),
    })
```

- [ ] **Step 2: 改 src/index.ts 传 redirect**

在 `src/index.ts` 的 `ctx.plugin(PluginGithub, {...})` 注册块（研究 §4 指出约 314-320 行），在配置对象里加一行：
```ts
    redirect: env.TOKEN_GITHUB_REDIRECT,
```
（与 `appId: env.TOKEN_GITHUB_APPID` 同风格。**部署者需在 `.env` 设 `TOKEN_GITHUB_REDIRECT` = GitHub OAuth App 登记的 callback URL，例如 `https://<域名>/api/github/authorize`。**）

- [ ] **Step 3: 类型检查 + 全量 github 测试**

Run: `npx tsc --noEmit -p .`
Expected: `src/plugins/github` 与 `src/index.ts` 下无新错误（inject 'http' 后 `ctx.http` 类型可用；`env.TOKEN_GITHUB_REDIRECT` 若类型不认，按 `src/index.ts` 现有 env 读取风格处理）。
Run: `npx vitest run src/plugins/github`
Expected: 全绿。

- [ ] **Step 4: 写真机冒烟清单**

Create `.debug/github-plugin/phase3-smoke-checklist.md`（部署到有公网 callback 的环境后人工执行——OAuth/建 hook 打不到本地）：
```markdown
# Phase 3 真机冒烟清单（需公网 callback）

前置：.env 设 TOKEN_GITHUB_APPID / TOKEN_GITHUB_APPSECRET / TOKEN_GITHUB_REDIRECT（= OAuth App 登记 callback）。
命令前缀按环境（生产 ! / 本地 ;）。

1. 授权：`github.authorize` → 收到 "请点击下面的链接继续操作：" + 链接。浏览器打开 → GitHub 授权 → 回调返回 200（浏览器空白页/状态码，正常）。
   - 验证：DB `user.github.accessToken` 已写入。
2. 注册 webhook：`github.repos <你的测试仓库> -a` → "添加仓库成功！"；GitHub 仓库 Settings→Webhooks 出现新 hook，url = <selfUrl>/api/github/webhook。
   - 验证：DB `github` 表新增 { id, name, secret }。
3. 订阅：在测试群 `gh <repo> -a`（authority≥2）→ "添加订阅成功！"；`gh -l` 列出该仓库。
   - 或一步到位：`github.repos <repo> -a -s`。
   - 或未注册仓库 `gh <repo> -a` → 提示 "尚未添加过仓库…发送空行或句号…" → 发 `.` → 自动建 hook + 订阅。
4. 推送：向该仓库 push → 群里收到 "[GitHub] <user> pushed to <repo>:<branch> …"（Phase 1/2 渲染）。
5. 改名：GitHub 上重命名仓库 → 再 push → 群里仍收到（改名迁移生效）；DB `github.name` 与各 channel webhooks key 已更新。
6. 取消：`gh <repo> -d` → "移除订阅成功！"；`github.repos <repo> -d` → "移除仓库成功！" 且 GitHub 上 hook 被删。
7. 反例：`gh notarepo -a` → "请输入正确的仓库名。"；未授权用户 `github.repos x/y -a` → 触发授权提示。
```

- [ ] **Step 5: Commit**

```bash
git add src/plugins/github/index.ts src/index.ts .debug/github-plugin/phase3-smoke-checklist.md
git commit -m "feat(github): wire OAuth/commands/rename into plugin entry + redirect env"
```

> 注：`.debug/` 被 gitignore，`git add` 该文件需 `-f` 或确认它能被追踪——若被忽略则改为**不提交**该清单（仅本地留存），提交其余两文件即可。

---

## Self-Review

**Spec/需求 覆盖：**
- OAuth authorize 命令 + 回调路由 + code 交换 + 401 refresh → Task 1(http.getTokens/withAuth) + Task 2(oauth) ✅
- `github`/`gh` -l/-a/-d（含未注册仓库的「发空行即添加」链式）→ Task 3 ✅
- `github.repos` -a/-d/-s（建/删 hook + DB + `-s` 链式 + 错误码映射）→ Task 4 ✅
- 仓库改名迁移 → Task 5 ✅
- redirect 配置注入（1:1 旧的手动 config.redirect，走新 env）→ Task 6 ✅
- 数据层/签名/secret/URL 兼容不变（复用 Phase 1 schema，建 hook 参数 1:1）→ 各 task 约束 ✅
- 回复串逐字取 locale JSON → Task 3/4 明确要求实施者核对 ✅
- 不引 octokit（方案 A）、bun-only、inject 加 http → Global Constraints + Task 1/6 ✅
- 交互对象（issue/star/引用回复）不做 → 明确留 Phase 4 ✅

**Placeholder 扫描：** Task 3 的 `applyReposCommand` 空桩是**有意的跨 task 占位**，Task 4 Step 3 明确「替换空桩」——非遗留 TODO。其余步骤均含完整代码/命令。✅

**类型一致性：** `GitHubHttp`(Task 1) 的 `getTokens/createWebhook/deleteWebhook` 签名在 Task 2/4/6 一致引用；`GitHubUser`/`OAuthTokens`(Task 1) 贯穿；`RepoStore`(Task 3) 被 Task 4 复用；`MSG`/`REPO_RE`(Task 3) 被 Task 4 复用；`WebhookDeps` 从 `getSecret`→`getHook`(Task 5) 后，Task 6 的 index.ts 接线与既有测试 stub(Task 5 Step 6) 同步更新——无悬空签名。✅

## 已知边界 / 风险

- **koishi 命令期 API 的确切形状**（`s.channel.$update()`、`s.prompt`、`s.execute(argv, true)`、`ctx.server.get` 回调、`ctx.http` 方法/错误）已用仓库先例 + 旧插件源佐证，但命令胶水层无单测——由 tsc + Task 6 真机冒烟清单兜底。实施者遇到签名不符**停下问**，勿猜。
- **OAuth state map 进程内内存**：重启丢失（秒级流程，可接受，1:1 旧行为）。
- `.debug/` 冒烟清单可能被 gitignore 挡住提交（Task 6 Step 5 已注明处理）。

## 后续 Phase

- Phase 4：交互对象（issue/star 命令 + 引用回复 react/comment/close + history + replyTimeout）。
- Phase 5：`github.user` 活跃度瓷砖卡片（此时才引 octokit GraphQL）。
