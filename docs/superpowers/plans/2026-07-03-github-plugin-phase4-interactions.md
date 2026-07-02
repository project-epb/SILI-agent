# GitHub 插件 Phase 4 实现计划：引用回复交互 + issue/star 命令

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给自研 github 插件补齐引用回复交互（`.reply`/`.react`/`.link`/`.close`/`.base`/`.merge`/`.rebase`/`.squash`/`.help`）与 `github.issue`/`github.star` 命令。

**Architecture:** 方案 B —— 新增独立的 `actions.ts`（事件→动作 url 映射）、`history.ts`（内存 msgId→动作）、`reply.ts`（纯函数 + ReplyHandler），Phase 2 渲染器零改动。webhook 广播后把 messageIds→actions 记进 history；一个 `ctx.middleware` 检测引用命中 history 后分发到 ReplyHandler。

**Tech Stack:** koishi 4.18 / bun runtime / vitest。HTTP 走现有 `GitHubHttp`（`ctx.http` Quester + `withAuth` 401 刷新）。

## Global Constraints

- **bun only**：装依赖 `bun install`，跑测试 `npx vitest run <path>`，类型检查 `npx tsc --noEmit -p .`。禁用 pnpm。
- **本期不引任何新依赖**（无 `bun add`）。
- 代码注释英文；已有其他语言注释更新时保持原语言。
- **纯函数单测**（`buildActions`/`parseReplyCommand`/`formatHelp`/`buildQuotedComment`/`ReplyHandler`/`HistoryStore`/`http.request`）；**命令 action 与 middleware 是 glue，由 `tsc --noEmit` + 生产真机验证，不单测**。
- 测试首行 `vi.mock('koishi', () => ({ Context: class {}, Random: { id: () => 'stub' } }))` 规避 koishi 顶层 loader 副作用（现有 `commands-repos.test.ts` 同款）。
- **不动 Phase 2 渲染器**；`events/util.ts` 的 `cleanBody` 已支持 INDICATOR 截断（util.ts:11-12），不要改它。
- 签名 / 路由 / DB schema 全不变；history 内存不建表。
- **8 种 reaction emoji（固定值）**：`+1` `-1` `laugh` `confused` `heart` `hooray` `rocket` `eyes`。
- **INDICATOR 固定值**：`<!-- BOT-MESSAGE-FOOTER -->`（与存量 bot 评论兼容）。
- **临时指令前缀硬编码 `.`**（不用 bot 命令前缀），help 匹配 `^[.!/]?help$/i`。
- 复用现有：`REPO_RE`、`describeHttpError`、`MSG`（`commands.ts`）；`GitHubHttp.withAuth`、`authHeaders`（`http.ts`）。
- 路径别名：`@/*→src/*`、`~/*→src/plugins/*`、`$utils/*→src/utils/*`。

---

## Task 1: actions.ts — 事件→动作映射

**Files:**
- Create: `src/plugins/github/actions.ts`
- Test: `src/plugins/github/__tests__/actions.test.ts`

**Interfaces:**
- Produces: `REACTIONS: readonly string[]`、`type ActionName`、`type ActionMap = Partial<Record<ActionName, any[]>>`、`buildActions(event: string, payload: any): ActionMap`

- [ ] **Step 1: 写失败测试** `src/plugins/github/__tests__/actions.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { buildActions, REACTIONS } from '../actions'

describe('REACTIONS', () => {
  it('is the 8 github reaction names in order', () => {
    expect(REACTIONS).toEqual(['+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes'])
  })
})

describe('buildActions', () => {
  it('issue_comment → link/react/reply', () => {
    const payload = {
      comment: { html_url: 'H', url: 'https://api/c' },
      issue: { comments_url: 'https://api/i/comments' },
    }
    expect(buildActions('issue_comment', payload)).toEqual({
      link: ['H'],
      react: ['https://api/c/reactions'],
      reply: ['https://api/i/comments'],
    })
  })

  it('commit_comment → reply targets the commit comments url with path/position', () => {
    const payload = {
      repository: { full_name: 'o/r' },
      comment: { html_url: 'H', url: 'https://api/c', commit_id: 'abc123', path: 'a.ts', position: 4 },
    }
    expect(buildActions('commit_comment', payload)).toEqual({
      link: ['H'],
      react: ['https://api/c/reactions'],
      reply: ['https://api.github.com/repos/o/r/commits/abc123/comments', { path: 'a.ts', position: 4 }],
    })
  })

  it('pull_request_review_comment → reply targets the review-comment replies url', () => {
    const payload = {
      repository: { full_name: 'o/r' },
      pull_request: { number: 7 },
      comment: { html_url: 'H', url: 'https://api/c', id: 55 },
    }
    expect(buildActions('pull_request_review_comment', payload)).toEqual({
      link: ['H'],
      react: ['https://api/c/reactions'],
      reply: ['https://api.github.com/repos/o/r/pulls/7/comments/55/replies'],
    })
  })

  it('issues → close/link/react/reply', () => {
    const payload = {
      issue: { url: 'https://api/i', html_url: 'H', comments_url: 'https://api/i/comments' },
    }
    expect(buildActions('issues', payload)).toEqual({
      close: ['https://api/i', 'https://api/i/comments'],
      link: ['H'],
      react: ['https://api/i/reactions'],
      reply: ['https://api/i/comments'],
    })
  })

  it('pull_request → base/close/link/merge/rebase/squash/react/reply', () => {
    const payload = {
      pull_request: {
        url: 'https://api/pr',
        issue_url: 'https://api/i',
        html_url: 'H',
        comments_url: 'https://api/i/comments',
      },
    }
    expect(buildActions('pull_request', payload)).toEqual({
      base: ['https://api/pr'],
      close: ['https://api/i', 'https://api/i/comments'],
      link: ['H'],
      merge: ['https://api/pr/merge'],
      rebase: ['https://api/pr/merge'],
      squash: ['https://api/pr/merge'],
      react: ['https://api/i/reactions'],
      reply: ['https://api/i/comments'],
    })
  })

  it('pull_request_review only acts on submitted', () => {
    const submitted = {
      action: 'submitted',
      review: { html_url: 'H' },
      pull_request: { comments_url: 'https://api/i/comments' },
    }
    expect(buildActions('pull_request_review', submitted)).toEqual({
      link: ['H'],
      reply: ['https://api/i/comments'],
    })
    expect(buildActions('pull_request_review', { action: 'dismissed' })).toEqual({})
  })

  it('push → link only; no-interaction events → empty', () => {
    expect(buildActions('push', { compare: 'C' })).toEqual({ link: ['C'] })
    expect(buildActions('star', {})).toEqual({})
    expect(buildActions('fork', {})).toEqual({})
    expect(buildActions('milestone', {})).toEqual({})
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/plugins/github/__tests__/actions.test.ts`
Expected: FAIL（`../actions` 不存在）

- [ ] **Step 3: 实现** `src/plugins/github/actions.ts`

```ts
/** The 8 reaction emoji GitHub accepts (squirrel-girl API), in canonical order. */
export const REACTIONS = ['+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes'] as const

/** Quick-reply action name → the ReplyHandler method it dispatches to. */
export type ActionName = 'link' | 'react' | 'reply' | 'close' | 'base' | 'merge' | 'rebase' | 'squash'

/** The actions a pushed message supports; each value is the arg list for ReplyHandler[name]. */
export type ActionMap = Partial<Record<ActionName, any[]>>

/**
 * Pure: map a webhook event + payload to the quick-reply actions it supports.
 * Mirrors the old events.js onComment/onIssue/onPullRequest action maps, minus `.shot`.
 * Events with no interaction return `{}`.
 */
export function buildActions(event: string, payload: any): ActionMap {
  switch (event) {
    case 'issue_comment': {
      const { comment, issue } = payload
      return {
        link: [comment.html_url],
        react: [comment.url + '/reactions'],
        reply: [issue.comments_url],
      }
    }
    case 'commit_comment': {
      const { comment, repository } = payload
      return {
        link: [comment.html_url],
        react: [comment.url + '/reactions'],
        reply: [
          `https://api.github.com/repos/${repository.full_name}/commits/${comment.commit_id}/comments`,
          { path: comment.path, position: comment.position },
        ],
      }
    }
    case 'pull_request_review_comment': {
      const { comment, pull_request, repository } = payload
      return {
        link: [comment.html_url],
        react: [comment.url + '/reactions'],
        reply: [
          `https://api.github.com/repos/${repository.full_name}/pulls/${pull_request.number}/comments/${comment.id}/replies`,
        ],
      }
    }
    case 'issues': {
      const { issue } = payload
      return {
        close: [issue.url, issue.comments_url],
        link: [issue.html_url],
        react: [issue.url + '/reactions'],
        reply: [issue.comments_url],
      }
    }
    case 'pull_request': {
      const { pull_request } = payload
      return {
        base: [pull_request.url],
        close: [pull_request.issue_url, pull_request.comments_url],
        link: [pull_request.html_url],
        merge: [pull_request.url + '/merge'],
        rebase: [pull_request.url + '/merge'],
        squash: [pull_request.url + '/merge'],
        react: [pull_request.issue_url + '/reactions'],
        reply: [pull_request.comments_url],
      }
    }
    case 'pull_request_review': {
      if (payload.action !== 'submitted') return {}
      return {
        link: [payload.review.html_url],
        reply: [payload.pull_request.comments_url],
      }
    }
    case 'push':
      return { link: [payload.compare] }
    default:
      return {}
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/plugins/github/__tests__/actions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/plugins/github/actions.ts src/plugins/github/__tests__/actions.test.ts
git commit -m "feat(github): add buildActions event→quick-reply action map"
```

---

## Task 2: reply.ts 纯函数 — parseReplyCommand / formatHelp / buildQuotedComment

**Files:**
- Create: `src/plugins/github/reply.ts`
- Test: `src/plugins/github/__tests__/reply.test.ts`

**Interfaces:**
- Consumes: `REACTIONS`（Task 1）
- Produces:
  - `parseReplyCommand(body: string): { name: string; message: string }`
  - `formatHelp(actionNames: string[]): string`
  - `buildQuotedComment(quotedText: string, userReply: string, footer: string): string`
  - `INDICATOR: string`（导出供测试断言）

- [ ] **Step 1: 写失败测试** `src/plugins/github/__tests__/reply.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { parseReplyCommand, formatHelp, buildQuotedComment, INDICATOR } from '../reply'

describe('parseReplyCommand', () => {
  it('treats .help / help / !help / /help (any case) as help', () => {
    for (const b of ['.help', 'help', '!help', '/help', 'HELP', '.Help']) {
      expect(parseReplyCommand(b)).toEqual({ name: 'help', message: '' })
    }
  })
  it('dot-prefixed → explicit action name + trailing message', () => {
    expect(parseReplyCommand('.close 修好了')).toEqual({ name: 'close', message: '修好了' })
    expect(parseReplyCommand('.link')).toEqual({ name: 'link', message: '' })
    expect(parseReplyCommand('.merge feat: x')).toEqual({ name: 'merge', message: 'feat: x' })
  })
  it('bare emoji name → react', () => {
    expect(parseReplyCommand('+1')).toEqual({ name: 'react', message: '+1' })
    expect(parseReplyCommand('rocket')).toEqual({ name: 'react', message: 'rocket' })
  })
  it('any other bare text → reply (default)', () => {
    expect(parseReplyCommand('说得好')).toEqual({ name: 'reply', message: '说得好' })
    expect(parseReplyCommand('help我看看')).toEqual({ name: 'reply', message: 'help我看看' })
  })
})

describe('formatHelp', () => {
  it('lists only the supported actions with descriptions', () => {
    const out = formatHelp(['close', 'link', 'react', 'reply'])
    expect(out).toContain('.reply')
    expect(out).toContain('.close')
    expect(out).not.toContain('.merge')
  })
})

describe('buildQuotedComment', () => {
  it('prefixes the quoted original per line, then reply, then INDICATOR + footer', () => {
    const out = buildQuotedComment('alice commented\nbody line', '+1 说得好', 'FOOTER')
    expect(out).toBe('> alice commented\n> body line\n\n+1 说得好\n\n' + INDICATOR + '\nFOOTER')
  })
  it('nested quotes accumulate ( > x → > > x )', () => {
    const out = buildQuotedComment('> earlier', 'ok', '')
    expect(out.split('\n')[0]).toBe('> > earlier')
  })
  it('empty quoted → reply + INDICATOR only', () => {
    expect(buildQuotedComment('', 'hi', '')).toBe('hi\n\n' + INDICATOR)
  })
  it('empty footer → no trailing footer line', () => {
    const out = buildQuotedComment('q', 'r', '')
    expect(out.endsWith(INDICATOR)).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/plugins/github/__tests__/reply.test.ts`
Expected: FAIL（`../reply` 不存在）

- [ ] **Step 3: 实现纯函数部分** `src/plugins/github/reply.ts`

```ts
import { REACTIONS } from './actions'

/** Marker inserted between a bot-authored comment body and its footer. cleanBody
 * (events/util.ts) cuts at this marker so a rebroadcast bot comment drops the footer. */
export const INDICATOR = '<!-- BOT-MESSAGE-FOOTER -->'

/** Pure: parse a quote-reply body into an action name + message. '.' is hard-coded
 * (NOT the bot command prefix) so the reply middleware bypasses the command system. */
export function parseReplyCommand(body: string): { name: string; message: string } {
  if (/^[.!/]?help$/i.test(body)) return { name: 'help', message: '' }
  if (body.startsWith('.')) {
    const name = body.slice(1).split(/\s/, 1)[0]
    return { name, message: body.slice(1 + name.length).trim() }
  }
  const name = (REACTIONS as readonly string[]).includes(body) ? 'react' : 'reply'
  return { name, message: body }
}

const ACTION_HELP: Record<string, string> = {
  reply: '.reply <文本> — 评论（直接打字即评论）',
  react: '.react <emoji> — 加 reaction（直接发 emoji 名亦可）',
  link: '.link — 回显链接',
  close: '.close [文本] — 关闭 issue/PR（可带评论）',
  base: '.base <分支> — 改 PR base 分支',
  merge: '.merge [标题] — 合并 PR',
  rebase: '.rebase [标题] — rebase 合并 PR',
  squash: '.squash [标题] — squash 合并 PR',
}

/** Pure: build the .help reply listing the actions this message supports. */
export function formatHelp(actionNames: string[]): string {
  const lines = actionNames.filter((n) => n in ACTION_HELP).map((n) => ACTION_HELP[n])
  return ['可用快捷指令（引用本消息）：', ...lines].join('\n')
}

/** Pure: a GitHub comment body = the quoted original as a markdown blockquote,
 * then the user's reply, then INDICATOR + footer. Nested quotes accumulate because
 * existing '>' lines gain another '> '. */
export function buildQuotedComment(quotedText: string, userReply: string, footer: string): string {
  const parts: string[] = []
  const quoted = quotedText.trim()
  if (quoted) {
    parts.push(quoted.split('\n').map((line) => '> ' + line).join('\n'))
    parts.push('') // blank line between quote and reply
  }
  parts.push(userReply)
  parts.push('')
  parts.push(INDICATOR)
  if (footer) parts.push(footer)
  return parts.join('\n')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/plugins/github/__tests__/reply.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/plugins/github/reply.ts src/plugins/github/__tests__/reply.test.ts
git commit -m "feat(github): add parseReplyCommand/formatHelp/buildQuotedComment"
```

---

## Task 3: http.ts — GitHubHttp 通用 authed request

**Files:**
- Modify: `src/plugins/github/http.ts`（加 `request` 方法）
- Test: `src/plugins/github/__tests__/http.test.ts`（改 `makeCtx` 让 `ctx.http` 可调用 + 加用例）

**Interfaces:**
- Produces: `GitHubHttp.request<T>(user: GitHubUser, method: string, url: string, body?: any, headers?: Record<string,string>): Promise<T>`

- [ ] **Step 1: 改 `makeCtx` 让 `ctx.http` 可调用 + 加失败测试** `src/plugins/github/__tests__/http.test.ts`

把文件顶部的 `makeCtx` 改为（`ctx.http` 既可调用又保留 `.post/.get/.delete`，现有用例不受影响）：

```ts
function makeCtx(overrides: any = {}) {
  const http: any = Object.assign(vi.fn(), { post: vi.fn(), delete: vi.fn(), get: vi.fn() })
  return {
    http,
    database: { set: vi.fn().mockResolvedValue(undefined) },
    server: { config: { selfUrl: 'https://sili.example' } },
    ...overrides,
  } as any
}
```

在文件末尾追加：

```ts
describe('request (generic authed)', () => {
  it('calls ctx.http(method, url, {data, headers}) with the auth header; extra headers merge over it', async () => {
    const ctx = makeCtx()
    ctx.http.mockResolvedValue({ ok: 1 })
    const http = new GitHubHttp(ctx, config)
    const out = await http.request(user(), 'POST', 'https://api.github.com/x', { a: 1 }, { accept: 'custom' })
    expect(out).toEqual({ ok: 1 })
    expect(ctx.http).toHaveBeenCalledWith('POST', 'https://api.github.com/x', {
      data: { a: 1 },
      headers: { authorization: 'token at0', accept: 'custom' },
    })
  })

  it('refreshes the token on 401 and retries (via withAuth)', async () => {
    const ctx = makeCtx()
    ctx.http
      .mockRejectedValueOnce({ response: { status: 401 } }) // first request
      .mockResolvedValueOnce({ id: 9 }) // retried request
    ctx.http.post.mockResolvedValueOnce({ access_token: 'AT2', refresh_token: 'RT2' }) // refresh getTokens
    const http = new GitHubHttp(ctx, config)
    const u = user()
    const out = await http.request(u, 'PUT', 'https://api.github.com/y')
    expect(out).toEqual({ id: 9 })
    expect(u.github.accessToken).toBe('AT2')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/plugins/github/__tests__/http.test.ts`
Expected: FAIL（`http.request` 不存在）

- [ ] **Step 3: 实现** —— 在 `GitHubHttp` 类里（`deleteWebhook` 之后）加：

```ts
  /** Generic authed request (401 auto-refresh via withAuth). Used by ReplyHandler,
   * github.issue, github.star. Body is sent as JSON; extra headers merge over the auth
   * headers (so e.g. the squirrel-girl accept can override the default). */
  request<T = any>(
    user: GitHubUser,
    method: string,
    url: string,
    body?: any,
    headers?: Record<string, string>
  ): Promise<T> {
    return this.withAuth(user, (token) =>
      (this.ctx.http as any)(method, url, {
        data: body,
        headers: { ...authHeaders(token), ...headers },
      })
    )
  }
```

（`authHeaders` 与 private `withAuth` 均已在 `http.ts` 内可用。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/plugins/github/__tests__/http.test.ts`
Expected: PASS（含既有用例）

- [ ] **Step 5: Commit**

```bash
git add src/plugins/github/http.ts src/plugins/github/__tests__/http.test.ts
git commit -m "feat(github): add GitHubHttp.request generic authed helper"
```

---

## Task 4: reply.ts — ReplyHandler

**Files:**
- Modify: `src/plugins/github/reply.ts`（加 `ReplyHandler` 类）
- Test: `src/plugins/github/__tests__/reply.test.ts`（加 `ReplyHandler` describe）

**Interfaces:**
- Consumes: `buildQuotedComment`（Task 2）、`REACTIONS`（Task 1）、`GitHubHttp.request`（Task 3）、`describeHttpError`（`commands.ts`，Task 4b 已有）、`GitHubUser`（`types.ts`）
- Produces: `class ReplyHandler` —— 构造 `(ctx, http, user, content, quotedText, footer)`；方法 `link/react/reply/close/base/merge/rebase/squash`

- [ ] **Step 1: 写失败测试** —— 在 `reply.test.ts` 顶部加 koishi mock（因为 ReplyHandler 经 `./commands` 间接引入 koishi），并追加 describe：

文件**第一行之前**插入：

```ts
import { vi } from 'vitest'
vi.mock('koishi', () => ({ Context: class {}, Random: { id: () => 'stub' } }))
```

（若 `reply.test.ts` 已从 vitest 具名导入，合并 `vi` 即可。）追加：

```ts
import { ReplyHandler } from '../reply'

function makeHandler(content: string, quotedText = 'Q', footer = 'F') {
  const request = vi.fn().mockResolvedValue(undefined)
  const ctx = { logger: () => ({ warn: vi.fn() }) } as any
  const http = { request } as any
  const user = { id: 7, github: { accessToken: 'at', refreshToken: 'rt' } }
  return { handler: new ReplyHandler(ctx, http, user, content, quotedText, footer), request, user }
}

describe('ReplyHandler', () => {
  it('link returns the url (no network)', async () => {
    const { handler, request } = makeHandler('')
    expect(await handler.link('https://x')).toBe('https://x')
    expect(request).not.toHaveBeenCalled()
  })

  it('react POSTs the emoji with the squirrel-girl accept header', async () => {
    const { handler, request, user } = makeHandler('+1')
    await handler.react('https://api/react')
    expect(request).toHaveBeenCalledWith(user, 'POST', 'https://api/react', { content: '+1' }, {
      accept: 'application/vnd.github.squirrel-girl-preview',
    })
  })

  it('react rejects an unknown emoji without calling the api', async () => {
    const { handler, request } = makeHandler('thumbsup')
    const out = await handler.react('https://api/react')
    expect(out).toContain('reaction')
    expect(request).not.toHaveBeenCalled()
  })

  it('reply POSTs a quoted comment body', async () => {
    const { handler, request, user } = makeHandler('好的', 'alice commented', 'F')
    await handler.reply('https://api/comments')
    expect(request).toHaveBeenCalledWith(user, 'POST', 'https://api/comments', {
      body: '> alice commented\n\n好的\n\n<!-- BOT-MESSAGE-FOOTER -->\nF',
    })
  })

  it('reply threads extra params (commit_comment path/position)', async () => {
    const { handler, request } = makeHandler('r', 'q', '')
    await handler.reply('https://api/x', { path: 'a.ts', position: 3 })
    expect(request.mock.calls[0][3]).toMatchObject({ path: 'a.ts', position: 3 })
  })

  it('close with content comments first, then PATCHes state=closed', async () => {
    const { handler, request } = makeHandler('done', 'q', '')
    await handler.close('https://api/i', 'https://api/i/comments')
    expect(request.mock.calls[0].slice(1, 3)).toEqual(['POST', 'https://api/i/comments'])
    expect(request.mock.calls[1].slice(1)).toEqual(['PATCH', 'https://api/i', { state: 'closed' }])
  })

  it('close without content only PATCHes', async () => {
    const { handler, request } = makeHandler('', 'q', '')
    await handler.close('https://api/i', 'https://api/i/comments')
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0].slice(1)).toEqual(['PATCH', 'https://api/i', { state: 'closed' }])
  })

  it('merge splits content into commit_title (first line) + commit_message (rest)', async () => {
    const { handler, request, user } = makeHandler('feat: title\nlong body', 'q', '')
    await handler.merge('https://api/pr/merge')
    expect(request).toHaveBeenCalledWith(user, 'PUT', 'https://api/pr/merge', {
      merge_method: 'merge',
      commit_title: 'feat: title',
      commit_message: 'long body',
    })
  })

  it('rebase/squash pass the merge_method', async () => {
    const a = makeHandler('t', 'q', ''); await a.handler.rebase('https://api/pr/merge')
    expect(a.request.mock.calls[0][3]).toMatchObject({ merge_method: 'rebase' })
    const b = makeHandler('t', 'q', ''); await b.handler.squash('https://api/pr/merge')
    expect(b.request.mock.calls[0][3]).toMatchObject({ merge_method: 'squash' })
  })

  it('base PATCHes the base branch', async () => {
    const { handler, request, user } = makeHandler('main', 'q', '')
    await handler.base('https://api/pr')
    expect(request).toHaveBeenCalledWith(user, 'PATCH', 'https://api/pr', { base: 'main' })
  })

  it('on api failure returns a hint with the http detail', async () => {
    const request = vi.fn().mockRejectedValue({ response: { status: 422, data: { message: 'Unprocessable' } } })
    const ctx = { logger: () => ({ warn: vi.fn() }) } as any
    const user = { id: 7, github: { accessToken: 'at', refreshToken: 'rt' } }
    const handler = new ReplyHandler(ctx, { request } as any, user, '好', 'q', '')
    const out = await handler.reply('https://api/x')
    expect(out).toContain('HTTP 422: Unprocessable')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/plugins/github/__tests__/reply.test.ts`
Expected: FAIL（`ReplyHandler` 未导出）

- [ ] **Step 3: 实现** —— 在 `reply.ts` 追加（`import` 补齐）：

```ts
import type { Context } from 'koishi'
import type { GitHubHttp } from './http'
import type { GitHubUser } from './types'
import { describeHttpError } from './commands'

/** Executes a single quick-reply action against GitHub. `content` is the user's cleaned
 * reply text; `quotedText` is the original pushed message (prefix already stripped). */
export class ReplyHandler {
  constructor(
    private ctx: Context,
    private http: GitHubHttp,
    private user: GitHubUser,
    private content: string,
    private quotedText: string,
    private footer: string
  ) {}

  /** Run a network action; on failure log + return a specific hint (never throw). */
  private async run(fn: () => Promise<unknown>, hint: string): Promise<string | undefined> {
    try {
      await fn()
    } catch (e: any) {
      this.ctx.logger('github').warn(e)
      const detail = describeHttpError(e)
      return detail ? `${hint}：${detail}` : `${hint}。`
    }
  }

  link(url: string): string {
    return url
  }

  react(url: string): Promise<string | undefined> | string {
    if (!(REACTIONS as readonly string[]).includes(this.content)) {
      return `未知的 reaction，请用：${REACTIONS.join(' ')}`
    }
    return this.run(
      () => this.http.request(this.user, 'POST', url, { content: this.content }, {
        accept: 'application/vnd.github.squirrel-girl-preview',
      }),
      'reaction 失败'
    )
  }

  reply(url: string, params?: Record<string, any>): Promise<string | undefined> {
    const body = buildQuotedComment(this.quotedText, this.content, this.footer)
    return this.run(() => this.http.request(this.user, 'POST', url, { body, ...params }), '评论失败')
  }

  async close(url: string, commentUrl: string): Promise<string | undefined> {
    if (this.content) {
      const err = await this.reply(commentUrl)
      if (err) return err
    }
    return this.run(() => this.http.request(this.user, 'PATCH', url, { state: 'closed' }), '关闭失败')
  }

  base(url: string): Promise<string | undefined> {
    return this.run(() => this.http.request(this.user, 'PATCH', url, { base: this.content }), '修改 base 失败')
  }

  merge(url: string, method = 'merge'): Promise<string | undefined> {
    const [title] = this.content.split('\n', 1)
    const message = this.content.slice(title.length)
    return this.run(
      () => this.http.request(this.user, 'PUT', url, {
        merge_method: method,
        commit_title: title.trim(),
        commit_message: message.trim(),
      }),
      '合并失败'
    )
  }

  rebase(url: string): Promise<string | undefined> {
    return this.merge(url, 'rebase')
  }

  squash(url: string): Promise<string | undefined> {
    return this.merge(url, 'squash')
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/plugins/github/__tests__/reply.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/plugins/github/reply.ts src/plugins/github/__tests__/reply.test.ts
git commit -m "feat(github): add ReplyHandler (react/reply/close/base/merge/rebase/squash/link)"
```

---

## Task 5: history.ts — 内存 HistoryStore

**Files:**
- Create: `src/plugins/github/history.ts`
- Test: `src/plugins/github/__tests__/history.test.ts`

**Interfaces:**
- Consumes: `ActionMap`（Task 1）
- Produces: `class HistoryStore` —— 构造 `(ctx, ttl)`；`record(messageIds: string[], actions: ActionMap): void`；`get(messageId: string): ActionMap | undefined`

- [ ] **Step 1: 写失败测试** `src/plugins/github/__tests__/history.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest'
import { HistoryStore } from '../history'

function makeCtx() {
  return { setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms) } as any
}

describe('HistoryStore', () => {
  it('records actions under every message id and reads them back', () => {
    const store = new HistoryStore(makeCtx(), 1000)
    store.record(['m1', 'm2'], { link: ['x'] })
    expect(store.get('m1')).toEqual({ link: ['x'] })
    expect(store.get('m2')).toEqual({ link: ['x'] })
    expect(store.get('m3')).toBeUndefined()
  })

  it('ignores empty message ids or empty actions', () => {
    const store = new HistoryStore(makeCtx(), 1000)
    store.record([], { link: ['x'] })
    store.record(['m'], {})
    expect(store.get('m')).toBeUndefined()
  })

  it('expires entries after the ttl', async () => {
    vi.useFakeTimers()
    try {
      const store = new HistoryStore(makeCtx(), 1000)
      store.record(['m'], { link: ['x'] })
      expect(store.get('m')).toEqual({ link: ['x'] })
      await vi.advanceTimersByTimeAsync(1001)
      expect(store.get('m')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/plugins/github/__tests__/history.test.ts`
Expected: FAIL（`../history` 不存在）

- [ ] **Step 3: 实现** `src/plugins/github/history.ts`

```ts
import type { Context } from 'koishi'
import type { ActionMap } from './actions'

/** In-memory map: pushed message id → the quick-reply actions it supports. Entries
 * expire after `ttl` (config.replyTimeout, default 1h). Lost on process restart —
 * matches the old plugin; no DB table. */
export class HistoryStore {
  private map: Record<string, ActionMap> = Object.create(null)

  constructor(private ctx: Context, private ttl: number) {}

  /** Record the same actions under each broadcast message id + schedule expiry.
   * No-op if there are no ids or no actions. */
  record(messageIds: string[], actions: ActionMap): void {
    if (!messageIds.length || !Object.keys(actions).length) return
    for (const id of messageIds) this.map[id] = actions
    this.ctx.setTimeout(() => {
      for (const id of messageIds) delete this.map[id]
    }, this.ttl)
  }

  get(messageId: string): ActionMap | undefined {
    return this.map[messageId]
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/plugins/github/__tests__/history.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/plugins/github/history.ts src/plugins/github/__tests__/history.test.ts
git commit -m "feat(github): add in-memory HistoryStore with ttl expiry"
```

---

## Task 6: webhook.ts — handleWebhook 产出 actions + applyWebhook 写 history

**Files:**
- Modify: `src/plugins/github/webhook.ts`
- Test: `src/plugins/github/__tests__/webhook.test.ts`（加 actions 断言）

**Interfaces:**
- Consumes: `buildActions`（Task 1）
- Produces: `WebhookResult.actions?: ActionMap`；`WebhookDeps.recordHistory?(messageIds: string[], actions: ActionMap): void`

- [ ] **Step 1: 写失败测试** —— 在 `webhook.test.ts` 找到一个 200-with-message 的用例（推送到订阅频道、渲染出消息的），断言其结果带上 `actions`。追加一个用例：

```ts
it('returns actions for an interactive event on success', async () => {
  const deps = {
    getHook: async () => ({ name: 'o/r', secret: 's' }),
    targets: () => ['onebot:1'],
    // handleWebhook does not call recordHistory; that is applyWebhook's job.
  } as any
  // valid signature over rawBody:
  const rawBody = 'payload=' + encodeURIComponent(JSON.stringify({
    repository: { full_name: 'o/r' },
    issue: { url: 'https://api/i', html_url: 'H', comments_url: 'https://api/i/comments', title: 't', number: 1, user: { type: 'User' } },
    sender: { login: 'alice' },
    action: 'opened',
  }))
  // NOTE: reuse whatever signature helper the existing suite uses; if the suite has a
  // makeSignedRequest/sign helper, use it. Otherwise assert only the actions shape via a
  // getHook whose secret matches a precomputed signature already used elsewhere in this file.
})
```

> 实现者注意：`webhook.test.ts` 已有一套构造合法签名的辅助（签名覆盖 rawBody）。**复用它**给一个 `issues/opened` 或 `issue_comment` 的样本 payload，断言 `result.actions` 深等于 `buildActions(event, payload)`（例如 `issues` → `{ close, link, react, reply }`）。不要新造签名算法。若现有辅助只覆盖某一个事件样本，就在该样本上加 `expect(result.actions).toEqual(buildActions('<event>', payload))`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/plugins/github/__tests__/webhook.test.ts`
Expected: FAIL（`result.actions` 为 undefined）

- [ ] **Step 3: 实现**

在 `webhook.ts` 顶部加 `import { buildActions, type ActionMap } from './actions'`。

`WebhookResult` 加字段：

```ts
export interface WebhookResult {
  status: number
  targets?: string[]
  message?: import('koishi').Fragment
  actions?: ActionMap
}
```

`WebhookDeps` 加：

```ts
  /** Record broadcast message ids → quick-reply actions (optional; wired to HistoryStore). */
  recordHistory?(messageIds: string[], actions: ActionMap): void
```

`handleWebhook` 的成功返回改为带 actions：

```ts
  if (!targets.length || message == null) return { status: 200 }
  return { status: 200, targets, message, actions: buildActions(event, payload) }
```

`applyWebhook` 的广播分支改为记录 history：

```ts
    if (result.targets?.length && result.message != null) {
      const content =
        typeof result.message === 'string' ? prefix + result.message : [prefix, result.message]
      const messageIds = await ctx.broadcast(result.targets, content as any)
      if (result.actions && deps.recordHistory) deps.recordHistory(messageIds, result.actions)
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/plugins/github/__tests__/webhook.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/plugins/github/webhook.ts src/plugins/github/__tests__/webhook.test.ts
git commit -m "feat(github): handleWebhook emits actions; applyWebhook records history"
```

---

## Task 7: commands.ts — github.issue / github.star

**Files:**
- Modify: `src/plugins/github/commands.ts`（加两条命令 + `MSG.requireAuth`）
- Test: 无新单测（命令 action 是 glue，`tsc --noEmit` + 真机验证；`REPO_RE` 已有单测覆盖）

**Interfaces:**
- Consumes: `GitHubHttp.request`（Task 3）、`REPO_RE`/`describeHttpError`/`MSG`（本文件）

- [ ] **Step 1: 提取 require-auth 文案为 `MSG.requireAuth`**

在 `MSG` 对象里加一行（值与 `applyReposCommand` 内现有内联文案完全一致）：

```ts
  requireAuth: '要使用此功能，请先对机器人进行授权。',
```

把 `applyReposCommand` 里原来内联的 `await s.send('要使用此功能，请先对机器人进行授权。')` 改成 `await s.send(MSG.requireAuth)`（保持行为不变，仅去重）。

- [ ] **Step 2: 在 `applyCommands` 里注册两条命令**

在 `applyCommands` 函数体末尾（`applyReposCommand(...)` 调用之后）加：

```ts
  applyIssueStarCommands(ctx, http)
```

并在文件内新增函数：

```ts
/** github.issue / github.star — direct authed actions (1:1 old plugin). */
function applyIssueStarCommands(ctx: Context, http: GitHubHttp): void {
  const requireAuth = async (s: any) => {
    await s.send(MSG.requireAuth)
    return s.execute({ name: 'github.authorize' })
  }

  ctx
    .command('github.issue [title] [body:text]')
    .userFields(['id', 'github'])
    .option('repo', '-r [repo:string]')
    .action(async ({ session, options }, title, body) => {
      const s = session!
      if (!options!.repo) return MSG.repoExpected
      if (!REPO_RE.test(options!.repo)) return MSG.repoInvalid
      if (!s.user!.github?.accessToken) return requireAuth(s)
      const user = { id: s.user!.id, github: s.user!.github }
      try {
        await http.request(user, 'POST', `https://api.github.com/repos/${options!.repo}/issues`, { title, body })
      } catch (e: any) {
        ctx.logger('github').warn(e)
        const detail = describeHttpError(e)
        return detail ? `创建 issue 失败：${detail}` : '创建 issue 失败。'
      }
      return '已创建 issue。'
    })

  ctx
    .command('github.star [name]')
    .userFields(['id', 'github'])
    .action(async ({ session }, name) => {
      const s = session!
      if (!name) return MSG.repoExpected
      if (!REPO_RE.test(name)) return MSG.repoInvalid
      if (!s.user!.github?.accessToken) return requireAuth(s)
      const user = { id: s.user!.id, github: s.user!.github }
      try {
        await http.request(user, 'PUT', `https://api.github.com/user/starred/${name}`)
      } catch (e: any) {
        ctx.logger('github').warn(e)
        const detail = describeHttpError(e)
        return detail ? `star 失败：${detail}` : 'star 失败。'
      }
      return `已 star ${name}。`
    })
}
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit -p . 2>&1 | grep -E "src/plugins/github" || echo "github: 0 errors"`
Expected: `github: 0 errors`

- [ ] **Step 4: 跑 github 测试确保无回归**

Run: `npx vitest run src/plugins/github`
Expected: PASS（含 `MSG` 既有断言；`MSG.requireAuth` 是新增键，不影响现有）

- [ ] **Step 5: Commit**

```bash
git add src/plugins/github/commands.ts
git commit -m "feat(github): add github.issue and github.star commands"
```

---

## Task 8: index.ts — 接线 history + reply middleware

**Files:**
- Modify: `src/plugins/github/index.ts`
- Test: 无新单测（接线 glue，`tsc --noEmit` + 真机验证）

**Interfaces:**
- Consumes: `HistoryStore`（Task 5）、`ReplyHandler`/`parseReplyCommand`/`formatHelp`（Task 2/4）、`applyWebhook` 的 `recordHistory`（Task 6）、`GitHubHttp`（现有）

- [ ] **Step 1: 加 import**

在 `index.ts` 顶部 import 区加：

```ts
import { HistoryStore } from './history'
import { ReplyHandler, parseReplyCommand, formatHelp } from './reply'
```

- [ ] **Step 2: 实例化 history 并接到 webhook**

在 `const http = new GitHubHttp(...)` 附近加：

```ts
    const history = new HistoryStore(ctx, this.config.replyTimeout ?? Time.hour)
```

把 `applyWebhook(ctx, this.config, { ... })` 的 deps 对象里加一行：

```ts
      recordHistory: (ids, actions) => history.record(ids, actions),
```

- [ ] **Step 3: 注册引用回复交互**

在 constructor 末尾（`applyWebhook(...)` 之后）加：

```ts
    // ---- quick-reply interactions (quote a pushed message → act on the GitHub resource) ----
    const prefix = this.config.messagePrefix ?? ''
    const footer = this.config.replyFooter ?? ''

    // Pull the github user field only when the quoted message is in history (needs a token).
    ctx.before('attach-user', (session, fields) => {
      if (session.quote && history.get(session.quote.id)) fields.add('github')
    })

    ctx.middleware((session, next) => {
      if (!session.quote) return next()
      const actions = history.get(session.quote.id)
      if (!actions) return next()
      const { name, message } = parseReplyCommand(session.stripped.content.trim())
      if (name === 'help') return formatHelp(Object.keys(actions))
      const params = (actions as Record<string, any[]>)[name]
      if (!params) return next()
      const user = { id: session.user!.id, github: session.user!.github }
      const quoted = session.quote.content ?? ''
      const quotedText = quoted.startsWith(prefix) ? quoted.slice(prefix.length) : quoted
      const handler = new ReplyHandler(ctx, http, user, message, quotedText, footer)
      return (handler as any)[name](...params)
    })
```

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit -p . 2>&1 | grep -E "src/plugins/github" || echo "github: 0 errors"`
Expected: `github: 0 errors`

- [ ] **Step 5: 全套测试 + 类型检查最终确认**

Run: `npx vitest run src/plugins/github && npx tsc --noEmit -p . 2>&1 | grep -cE "src/plugins/github"`
Expected: vitest 全绿；tsc github 错误数为 `0`

- [ ] **Step 6: Commit**

```bash
git add src/plugins/github/index.ts
git commit -m "feat(github): wire history + quote-reply middleware"
```

---

## 真机冒烟（全部 task 完成后，部署到生产验证）

引用交互依赖真实 webhook 推送 + OneBot 引用回复，无法单测，须真机走一遍（生产已是本分支的部署目标）：

1. 订阅一个自己有权限的仓库（`github.repos -a owner/repo -s`），在该仓库开一个 issue → 群里收到推送。
2. 引用该推送消息：直接打字 → 应在 issue 下评论（GitHub 上评论带 `> 引用上下文` + footer）；发 `+1` → 应加 👍 reaction；`.link` → 回显链接；`.help` → 列出可用指令；`.close 完成` → 评论并关闭。
3. 引用 PR 推送：`.merge` / `.rebase` / `.squash` / `.base main` 验证。
4. `github.issue 标题 正文 -r owner/repo`、`github.star owner/repo`。
5. 确认 bot 代发的评论被推回群时**不带 footer**（cleanBody 截断生效）。

---

## Self-Review 记录（写计划者自查）

- **Spec 覆盖**：9 个临时指令（reply/react/link/close/base/merge/rebase/squash/help）→ Task 1（动作 url）+ Task 2（parse/help）+ Task 4（执行）+ Task 8（分发）；issue/star → Task 7；两个增强 → Task 2（buildQuotedComment）+ Task 8（stripped.content + prefix 去除）；history 内存 → Task 5/6/8；GitHubHttp.request → Task 3；INDICATOR → 复用 cleanBody（无 task，Task 2 插入标记）。全覆盖。
- **类型一致**：`ActionMap`/`ActionName`/`REACTIONS`（Task 1）在 Task 2/4/6/8 一致引用；`ReplyHandler` 构造签名 `(ctx, http, user, content, quotedText, footer)` 在 Task 4 定义、Task 8 调用一致；`http.request(user, method, url, body?, headers?)` 在 Task 3 定义、Task 4/7 调用一致。
- **无 placeholder**：各步含完整代码；唯一「实现者注意」在 Task 6 Step 1 —— 因签名辅助是现有测试文件的既有设施，要求复用而非新造，属合理指引非占位。
