# GitHub 插件 Phase 2：其余事件渲染器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把旧 `koishi-plugin-github` 的其余事件渲染器（push 之外的全部）1:1 移植为纯函数，注册进 `renderers`，使订阅群能收到 issue / PR / 评论 / fork / star 等事件推送。

**Architecture:** 每个 `x-github-event` 对应一个纯函数渲染器 `(payload, opts) => Fragment | null`，内部按 `payload.action` 分支；返回 `null` 表示跳过（bot 发起 / 无 body / 无关 action）。正文（issue/PR/comment body）经 `cleanBody()` 纯文本处理（不引 markdown 库）并按 `bodyMaxLength` 截断。交互对象（link/react/reply/close）属 Phase 4，本阶段渲染器只产出消息文本。

**Tech Stack:** TypeScript、koishi `Fragment`、vitest。移植源：`node_modules/koishi-plugin-github/lib/events.js`。设计见 `docs/superpowers/specs/2026-07-01-github-plugin-design.md`。

## Global Constraints

- **包管理器只用 bun**（`bun add`，禁 pnpm）。本阶段不新增运行时依赖（正文纯文本，**不引 `koishi-plugin-markdown`**）。
- 渲染器分派键 = `x-github-event`（不含 action）；单个渲染器内部 `switch(payload.action)`。
- `EventRenderer` 签名统一为 `(payload: any, opts: RenderOptions) => Fragment | null`；`null` = 跳过。不使用 opts 的渲染器可省略该形参（仍可赋给该类型）。
- 正文处理走 `cleanBody(source, maxLength)`：去掉 `<!-- BOT-MESSAGE-FOOTER -->` 及其后内容、剥离整行 HTML 注释、合并连续空行、trim；超 `maxLength` 截断加 `…`。**不做 markdown 渲染（原样纯文本）。**
- `bodyMaxLength`：Config 字段，`static Config` 默认 **500**。
- 交互对象（link/react/reply/close/shot/merge…）**不在本阶段**（Phase 4）。渲染器只返回消息文本。
- 消息内容与旧 `events.js` **逐字一致**（把 `transform(body)` 换成 `cleanBody(body, max)`；其余文案照抄）。
- 注释用英文；测试在 `src/plugins/github/__tests__/`。别名 `~/*`→`src/plugins/*`。

---

### Task 1: cleanBody / issueName 工具 + RenderOptions 管线 + config

**Files:**
- Create: `src/plugins/github/events/util.ts`
- Create: `src/plugins/github/__tests__/events-util.test.ts`
- Modify: `src/plugins/github/types.ts`（`RenderOptions`、改 `EventRenderer`、加 `bodyMaxLength`）
- Modify: `src/plugins/github/webhook.ts`（handleWebhook 传 renderOptions；applyWebhook 提供）
- Modify: `src/plugins/github/index.ts`（`static Config` 加 `bodyMaxLength`）

**Interfaces:**
- Produces:
  - `cleanBody(source: string | undefined | null, maxLength: number): string`
  - `issueName(repository: any, issue: any): string`（`` `${repository.full_name}#${issue.number}` ``）
  - `RenderOptions { bodyMaxLength: number }`（types.ts）
  - `EventRenderer = (payload: any, opts: RenderOptions) => Fragment | null`（types.ts，改签名）

- [ ] **Step 1: 写 util 失败测试**

Create `src/plugins/github/__tests__/events-util.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { cleanBody, issueName } from '../events/util'

describe('cleanBody', () => {
  it('returns empty string for empty/null/undefined', () => {
    expect(cleanBody('', 500)).toBe('')
    expect(cleanBody(null, 500)).toBe('')
    expect(cleanBody(undefined, 500)).toBe('')
  })
  it('drops everything from the bot-message-footer indicator onward', () => {
    expect(cleanBody('hello<!-- BOT-MESSAGE-FOOTER -->world', 500)).toBe('hello')
  })
  it('strips standalone HTML comment lines', () => {
    expect(cleanBody('a\n<!-- hi -->\nb', 500)).toBe('a\nb')
  })
  it('collapses blank lines and trims', () => {
    expect(cleanBody('  a\n\n\n  b  ', 500)).toBe('a\n  b')
  })
  it('truncates longer than maxLength with an ellipsis', () => {
    expect(cleanBody('abcdef', 3)).toBe('abc…')
  })
  it('does not truncate when maxLength is 0', () => {
    expect(cleanBody('abcdef', 0)).toBe('abcdef')
  })
})

describe('issueName', () => {
  it('formats as full_name#number', () => {
    expect(issueName({ full_name: 'org/repo' }, { number: 7 })).toBe('org/repo#7')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/plugins/github/__tests__/events-util.test.ts`
Expected: FAIL（`Cannot find module '../events/util'`）。

- [ ] **Step 3: 写 util 实现**

Create `src/plugins/github/events/util.ts`:

```ts
/** Marker the old plugin appends to bot-authored bodies; everything after it is dropped. */
const INDICATOR = '<!-- BOT-MESSAGE-FOOTER -->'

/**
 * Plain-text cleanup of an issue/PR/comment body (NO markdown rendering):
 * cut at the footer indicator, strip whole-line HTML comments, collapse blank
 * lines, trim, then truncate to maxLength (0 = no limit) with an ellipsis.
 */
export function cleanBody(source: string | undefined | null, maxLength: number): string {
  if (!source) return ''
  const i = source.indexOf(INDICATOR)
  if (i >= 0) source = source.slice(0, i)
  source = source.replace(/^<!--(.*)-->$/gm, '').trim().replace(/\n\s*\n/g, '\n')
  if (maxLength > 0 && source.length > maxLength) source = source.slice(0, maxLength) + '…'
  return source
}

/** "owner/repo#123" — used across issue/PR/comment renderers. */
export function issueName(repository: any, issue: any): string {
  return `${repository.full_name}#${issue.number}`
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/plugins/github/__tests__/events-util.test.ts`
Expected: PASS（7 用例全绿）。

- [ ] **Step 5: 改 types.ts 加 RenderOptions + 改 EventRenderer + config**

在 `src/plugins/github/types.ts`：把
```ts
/** Renders a parsed webhook payload into a chat message, or null to skip. */
export type EventRenderer = (payload: any) => Fragment | null
```
改为
```ts
/** Options threaded into renderers (e.g. body truncation length). */
export interface RenderOptions {
  bodyMaxLength: number
}

/** Renders a parsed webhook payload into a chat message, or null to skip.
 * Renderers that don't need `opts` may omit the parameter. */
export type EventRenderer = (payload: any, opts: RenderOptions) => Fragment | null
```
并在 `Config` 接口里加一行（放 `replyTimeout` 之后）：
```ts
  /** Max characters of an issue/PR/comment body before truncation. Default 500; 0 = no limit. */
  bodyMaxLength?: number
```

- [ ] **Step 6: 改 webhook.ts 传 renderOptions**

在 `src/plugins/github/webhook.ts`：
1. 顶部 import 补 `RenderOptions`（与现有 `Config` 同一行来源）：把 `import type { Config } from './types'` 改为 `import type { Config, RenderOptions } from './types'`。
2. `handleWebhook` 增加可选形参并传给渲染器。把函数签名与渲染调用改为：
```ts
export async function handleWebhook(
  headers: Record<string, any>,
  rawBody: string | undefined,
  body: any,
  deps: WebhookDeps,
  renderOptions: RenderOptions = { bodyMaxLength: 500 }
): Promise<WebhookResult> {
```
并把原来的
```ts
  const message = render ? render(payload) : null
```
改为
```ts
  const message = render ? render(payload, renderOptions) : null
```
3. `applyWebhook` 里把调用改为传入配置的截断长度。把
```ts
    const result = await handleWebhook(koa.headers, rawBody, reqBody, deps)
```
改为
```ts
    const result = await handleWebhook(koa.headers, rawBody, reqBody, deps, {
      bodyMaxLength: config.bodyMaxLength ?? 500,
    })
```

- [ ] **Step 7: 改 index.ts 的 static Config**

在 `src/plugins/github/index.ts` 的 `static Config = Schema.object({...})` 里，`replyTimeout` 那行之后加：
```ts
    bodyMaxLength: Schema.natural().default(500),
```

- [ ] **Step 8: 全量类型检查 + 现有测试回归**

Run: `npx tsc --noEmit -p .`
Expected: 无新错误（push.ts 的 `(payload) => ...` 仍可赋给新 `EventRenderer`；handleWebhook 旧调用因 renderOptions 有默认值不受影响）。

Run: `npx vitest run src/plugins/github`
Expected: 现有 verify/subscribe/push/webhook + 新 events-util 全 PASS。

- [ ] **Step 9: Commit**

```bash
git add src/plugins/github/events/util.ts src/plugins/github/__tests__/events-util.test.ts src/plugins/github/types.ts src/plugins/github/webhook.ts src/plugins/github/index.ts
git commit -m "feat(github): cleanBody/issueName util + render options + bodyMaxLength config"
```

---

### Task 2: 评论家族渲染器（commit_comment / issue_comment / pull_request_review_comment）

**Files:**
- Create: `src/plugins/github/events/comment.ts`
- Create: `src/plugins/github/__tests__/events-comment.test.ts`
- Modify: `src/plugins/github/events/index.ts`（注册三个渲染器）

**Interfaces:**
- Consumes: `cleanBody`、`issueName`（Task 1）、`EventRenderer`/`RenderOptions`（Task 1）
- Produces: `renderCommitComment`, `renderIssueComment`, `renderPullRequestReviewComment`（均 `EventRenderer`）

- [ ] **Step 1: 写失败测试**

Create `src/plugins/github/__tests__/events-comment.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  renderCommitComment,
  renderIssueComment,
  renderPullRequestReviewComment,
} from '../events/comment'

const opts = { bodyMaxLength: 500 }
const repo = { full_name: 'org/repo' }

describe('renderIssueComment', () => {
  const base = {
    action: 'created',
    repository: repo,
    sender: { login: 'alice' },
    issue: { number: 5, pull_request: undefined },
    comment: { user: { login: 'alice', type: 'User' }, body: 'looks good' },
  }
  it('renders a created issue comment with body', () => {
    expect(renderIssueComment(base, opts)).toBe('alice commented on issue org/repo#5\nlooks good')
  })
  it('labels PR comments as pull request', () => {
    const pr = { ...base, issue: { number: 5, pull_request: {} } }
    expect(renderIssueComment(pr, opts)).toBe('alice commented on pull request org/repo#5\nlooks good')
  })
  it('edited action says "edited a comment"', () => {
    expect(renderIssueComment({ ...base, action: 'edited' }, opts))
      .toBe('alice edited a comment on issue org/repo#5\nlooks good')
  })
  it('deleted action produces a delete line and no body', () => {
    expect(renderIssueComment({ ...base, action: 'deleted' }, opts))
      .toBe('alice deleted a comment on issue org/repo#5')
  })
  it('skips bot-authored comments', () => {
    expect(renderIssueComment({ ...base, comment: { user: { login: 'b', type: 'Bot' }, body: 'x' } }, opts)).toBeNull()
  })
})

describe('renderCommitComment', () => {
  it('renders commit id (6) + path + body', () => {
    const p = {
      action: 'created', repository: repo, sender: { login: 'alice' },
      comment: { user: { login: 'alice', type: 'User' }, body: 'nit', commit_id: 'abcdef1234', path: 'a/b.ts' },
    }
    expect(renderCommitComment(p, opts))
      .toBe('alice commented on commit org/repo@abcdef\nPath: a/b.ts\nnit')
  })
})

describe('renderPullRequestReviewComment', () => {
  it('renders review comment with pr number + path + body', () => {
    const p = {
      action: 'created', repository: repo, sender: { login: 'alice' },
      pull_request: { number: 9 },
      comment: { user: { login: 'alice', type: 'User' }, body: 'why?', path: 'a/b.ts' },
    }
    expect(renderPullRequestReviewComment(p, opts))
      .toBe('alice commented on pull request review org/repo#9\nPath: a/b.ts\nwhy?')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/plugins/github/__tests__/events-comment.test.ts`
Expected: FAIL（`Cannot find module '../events/comment'`）。

- [ ] **Step 3: 写实现**

Create `src/plugins/github/events/comment.ts`:

```ts
import type { EventRenderer, RenderOptions } from '../types'
import { cleanBody, issueName } from './util'

/** Shared comment wrapper (faithful port of the old onComment factory, message text only). */
function renderComment(payload: any, target: string, opts: RenderOptions): string | null {
  const { user, body } = payload.comment
  if (user?.type === 'Bot') return null
  if (payload.action === 'deleted') {
    return `${payload.sender.login} deleted a comment on ${target}`
  }
  const operation = payload.action === 'created' ? 'commented' : 'edited a comment'
  return `${user.login} ${operation} on ${target}\n${cleanBody(body, opts.bodyMaxLength)}`
}

export const renderCommitComment: EventRenderer = (payload, opts) => {
  const { repository, comment } = payload
  const target = `commit ${repository.full_name}@${comment.commit_id.slice(0, 6)}\nPath: ${comment.path}`
  return renderComment(payload, target, opts)
}

export const renderIssueComment: EventRenderer = (payload, opts) => {
  const { repository, issue } = payload
  const type = issue.pull_request ? 'pull request' : 'issue'
  const target = `${type} ${issueName(repository, issue)}`
  return renderComment(payload, target, opts)
}

export const renderPullRequestReviewComment: EventRenderer = (payload, opts) => {
  const { repository, comment, pull_request } = payload
  const target = `pull request review ${issueName(repository, pull_request)}\nPath: ${comment.path}`
  return renderComment(payload, target, opts)
}
```

- [ ] **Step 4: 注册进 events/index.ts**

把 `src/plugins/github/events/index.ts` 改为：
```ts
import type { EventRenderer } from '../types'
import { renderPush } from './push'
import {
  renderCommitComment,
  renderIssueComment,
  renderPullRequestReviewComment,
} from './comment'

/** event name (x-github-event) -> renderer. */
export const renderers: Record<string, EventRenderer> = {
  push: renderPush,
  commit_comment: renderCommitComment,
  issue_comment: renderIssueComment,
  pull_request_review_comment: renderPullRequestReviewComment,
}
```

- [ ] **Step 5: 跑测试 + 类型检查**

Run: `npx vitest run src/plugins/github/__tests__/events-comment.test.ts`
Expected: PASS。
Run: `npx tsc --noEmit -p .`
Expected: 无新错误。

- [ ] **Step 6: Commit**

```bash
git add src/plugins/github/events/comment.ts src/plugins/github/__tests__/events-comment.test.ts src/plugins/github/events/index.ts
git commit -m "feat(github): comment-family event renderers"
```

---

### Task 3: issues 渲染器

**Files:**
- Create: `src/plugins/github/events/issues.ts`
- Create: `src/plugins/github/__tests__/events-issues.test.ts`
- Modify: `src/plugins/github/events/index.ts`（注册 `issues`）

**Interfaces:**
- Consumes: `cleanBody`、`issueName`、`EventRenderer`
- Produces: `renderIssues`（`EventRenderer`）

- [ ] **Step 1: 写失败测试**

Create `src/plugins/github/__tests__/events-issues.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { renderIssues } from '../events/issues'

const opts = { bodyMaxLength: 500 }
const repo = { full_name: 'org/repo' }
const base = {
  repository: repo,
  sender: { login: 'alice' },
  issue: { number: 3, title: 'Bug', body: 'it breaks', user: { type: 'User' } },
}

describe('renderIssues', () => {
  it('opened: sender + name + title + body', () => {
    expect(renderIssues({ ...base, action: 'opened' }, opts))
      .toBe('alice opened an issue org/repo#3\nTitle: Bug\nit breaks')
  })
  it('opened with changes (transfer artifact) is skipped', () => {
    expect(renderIssues({ ...base, action: 'opened', changes: { foo: 1 } }, opts)).toBeNull()
  })
  it('closed: sender closed + name + title', () => {
    expect(renderIssues({ ...base, action: 'closed' }, opts))
      .toBe('alice closed issue org/repo#3\nBug')
  })
  it('reopened', () => {
    expect(renderIssues({ ...base, action: 'reopened' }, opts))
      .toBe('alice reopened issue org/repo#3\nBug')
  })
  it('transferred: old -> new name + title', () => {
    const p = {
      ...base, action: 'transferred',
      changes: { new_issue: { number: 8 }, new_repository: { full_name: 'org/other' } },
    }
    expect(renderIssues(p, opts))
      .toBe('alice transferred issue org/repo#3 to org/other#8\nBug')
  })
  it('skips bot-authored issues', () => {
    expect(renderIssues({ ...base, action: 'opened', issue: { ...base.issue, user: { type: 'Bot' } } }, opts)).toBeNull()
  })
  it('unknown action -> null', () => {
    expect(renderIssues({ ...base, action: 'labeled' }, opts)).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/plugins/github/__tests__/events-issues.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

Create `src/plugins/github/events/issues.ts`:

```ts
import type { EventRenderer } from '../types'
import { cleanBody, issueName } from './util'

export const renderIssues: EventRenderer = (payload, opts) => {
  const { repository, issue, sender, changes } = payload
  if (issue.user?.type === 'Bot') return null
  const name = issueName(repository, issue)
  switch (payload.action) {
    case 'opened':
      if (changes) return null // ignore the "opened" fired during a transfer
      return [
        `${sender.login} opened an issue ${name}`,
        `Title: ${issue.title}`,
        cleanBody(issue.body, opts.bodyMaxLength),
      ].join('\n')
    case 'closed':
      return `${sender.login} closed issue ${name}\n${issue.title}`
    case 'reopened':
      return `${sender.login} reopened issue ${name}\n${issue.title}`
    case 'transferred': {
      const newName = issueName(changes.new_repository, changes.new_issue)
      return `${sender.login} transferred issue ${name} to ${newName}\n${issue.title}`
    }
    default:
      return null
  }
}
```

- [ ] **Step 4: 注册进 events/index.ts**

在 `src/plugins/github/events/index.ts` 的 import 区加 `import { renderIssues } from './issues'`，并在 `renderers` 对象里加一行 `issues: renderIssues,`。

- [ ] **Step 5: 跑测试 + 类型检查**

Run: `npx vitest run src/plugins/github/__tests__/events-issues.test.ts`
Expected: PASS。
Run: `npx tsc --noEmit -p .`
Expected: 无新错误。

- [ ] **Step 6: Commit**

```bash
git add src/plugins/github/events/issues.ts src/plugins/github/__tests__/events-issues.test.ts src/plugins/github/events/index.ts
git commit -m "feat(github): issues event renderer"
```

---

### Task 4: pull_request + pull_request_review 渲染器

**Files:**
- Create: `src/plugins/github/events/pull-request.ts`
- Create: `src/plugins/github/__tests__/events-pull-request.test.ts`
- Modify: `src/plugins/github/events/index.ts`（注册 `pull_request`、`pull_request_review`）

**Interfaces:**
- Consumes: `cleanBody`、`issueName`、`EventRenderer`
- Produces: `renderPullRequest`, `renderPullRequestReview`（`EventRenderer`）

- [ ] **Step 1: 写失败测试**

Create `src/plugins/github/__tests__/events-pull-request.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { renderPullRequest, renderPullRequestReview } from '../events/pull-request'

const opts = { bodyMaxLength: 500 }
const repo = { full_name: 'org/repo', owner: { login: 'org' } }
const pr = {
  number: 12, title: 'Add X', body: 'does X', draft: false, merged: false,
  user: { type: 'User' },
  base: { label: 'org:main' }, head: { label: 'org:feature' },
}
const base = { repository: repo, sender: { login: 'alice' }, pull_request: pr }

describe('renderPullRequest', () => {
  it('opened: header with base <- head, title, body; strips owner: prefix from labels', () => {
    expect(renderPullRequest({ ...base, action: 'opened' }, opts))
      .toBe('alice opened a pull request org/repo#12 (main ← feature)\nTitle: Add X\ndoes X')
  })
  it('opened draft says drafted', () => {
    expect(renderPullRequest({ ...base, action: 'opened', pull_request: { ...pr, draft: true } }, opts))
      .toBe('alice drafted a pull request org/repo#12 (main ← feature)\nTitle: Add X\ndoes X')
  })
  it('closed unmerged', () => {
    expect(renderPullRequest({ ...base, action: 'closed' }, opts))
      .toBe('alice closed pull request org/repo#12\nAdd X')
  })
  it('closed merged says merged', () => {
    expect(renderPullRequest({ ...base, action: 'closed', pull_request: { ...pr, merged: true } }, opts))
      .toBe('alice merged pull request org/repo#12\nAdd X')
  })
  it('reopened', () => {
    expect(renderPullRequest({ ...base, action: 'reopened' }, opts))
      .toBe('alice reopened pull request org/repo#12\nAdd X')
  })
  it('review_requested from a user', () => {
    expect(renderPullRequest({ ...base, action: 'review_requested', requested_reviewer: { login: 'bob' } }, opts))
      .toBe('alice requested a review from bob on org/repo#12')
  })
  it('review_requested from a team', () => {
    expect(renderPullRequest({ ...base, action: 'review_requested', requested_team: { name: 'core' } }, opts))
      .toBe('alice requested a review from team core on org/repo#12')
  })
  it('converted_to_draft', () => {
    expect(renderPullRequest({ ...base, action: 'converted_to_draft' }, opts))
      .toBe('alice marked org/repo#12 as draft')
  })
  it('ready_for_review', () => {
    expect(renderPullRequest({ ...base, action: 'ready_for_review' }, opts))
      .toBe('alice marked org/repo#12 as ready for review')
  })
  it('skips bot-authored PRs', () => {
    expect(renderPullRequest({ ...base, action: 'opened', pull_request: { ...pr, user: { type: 'Bot' } } }, opts)).toBeNull()
  })
  it('unknown action -> null', () => {
    expect(renderPullRequest({ ...base, action: 'labeled' }, opts)).toBeNull()
  })
})

describe('renderPullRequestReview', () => {
  const rbase = {
    action: 'submitted', repository: repo, pull_request: pr,
    review: { body: 'LGTM', user: { login: 'bob', type: 'User' } },
  }
  it('submitted with body', () => {
    expect(renderPullRequestReview(rbase, opts)).toBe('bob reviewed pull request org/repo#12\nLGTM')
  })
  it('empty review body -> null', () => {
    expect(renderPullRequestReview({ ...rbase, review: { body: '', user: { type: 'User' } } }, opts)).toBeNull()
  })
  it('non-submitted action -> null', () => {
    expect(renderPullRequestReview({ ...rbase, action: 'edited' }, opts)).toBeNull()
  })
  it('bot reviewer -> null', () => {
    expect(renderPullRequestReview({ ...rbase, review: { body: 'x', user: { type: 'Bot' } } }, opts)).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/plugins/github/__tests__/events-pull-request.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

Create `src/plugins/github/events/pull-request.ts`:

```ts
import type { EventRenderer } from '../types'
import { cleanBody, issueName } from './util'

export const renderPullRequest: EventRenderer = (payload, opts) => {
  const { repository, sender } = payload
  const pr = payload.pull_request
  if (pr.user?.type === 'Bot') return null
  const name = issueName(repository, pr)
  switch (payload.action) {
    case 'opened': {
      const prefix = new RegExp(`^${repository.owner.login}:`)
      const baseLabel = pr.base.label.replace(prefix, '')
      const headLabel = pr.head.label.replace(prefix, '')
      return [
        `${sender.login} ${pr.draft ? 'drafted' : 'opened'} a pull request ${name} (${baseLabel} ← ${headLabel})`,
        `Title: ${pr.title}`,
        cleanBody(pr.body, opts.bodyMaxLength),
      ].join('\n')
    }
    case 'closed':
      return `${sender.login} ${pr.merged ? 'merged' : 'closed'} pull request ${name}\n${pr.title}`
    case 'reopened':
      return `${sender.login} reopened pull request ${name}\n${pr.title}`
    case 'review_requested':
      return 'requested_reviewer' in payload
        ? `${sender.login} requested a review from ${payload.requested_reviewer.login} on ${name}`
        : `${sender.login} requested a review from team ${payload.requested_team.name} on ${name}`
    case 'converted_to_draft':
      return `${sender.login} marked ${name} as draft`
    case 'ready_for_review':
      return `${sender.login} marked ${name} as ready for review`
    default:
      return null
  }
}

export const renderPullRequestReview: EventRenderer = (payload, opts) => {
  if (payload.action !== 'submitted') return null
  const { review, repository, pull_request } = payload
  if (!review.body) return null
  if (review.user?.type === 'Bot') return null
  const name = issueName(repository, pull_request)
  return [
    `${review.user.login} reviewed pull request ${name}`,
    cleanBody(review.body, opts.bodyMaxLength),
  ].join('\n')
}
```

- [ ] **Step 4: 注册进 events/index.ts**

在 `src/plugins/github/events/index.ts` 的 import 区加 `import { renderPullRequest, renderPullRequestReview } from './pull-request'`，并在 `renderers` 对象里加两行：
```ts
  pull_request: renderPullRequest,
  pull_request_review: renderPullRequestReview,
```

- [ ] **Step 5: 跑测试 + 类型检查**

Run: `npx vitest run src/plugins/github/__tests__/events-pull-request.test.ts`
Expected: PASS。
Run: `npx tsc --noEmit -p .`
Expected: 无新错误。

- [ ] **Step 6: Commit**

```bash
git add src/plugins/github/events/pull-request.ts src/plugins/github/__tests__/events-pull-request.test.ts src/plugins/github/events/index.ts
git commit -m "feat(github): pull_request and pull_request_review renderers"
```

---

### Task 5: create / delete / fork / milestone / star 渲染器

**Files:**
- Create: `src/plugins/github/events/misc.ts`
- Create: `src/plugins/github/__tests__/events-misc.test.ts`
- Modify: `src/plugins/github/events/index.ts`（注册 5 个）

**Interfaces:**
- Consumes: `EventRenderer`
- Produces: `renderCreate`, `renderDelete`, `renderFork`, `renderMilestone`, `renderStar`（`EventRenderer`）

- [ ] **Step 1: 写失败测试**

Create `src/plugins/github/__tests__/events-misc.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { renderCreate, renderDelete, renderFork, renderMilestone, renderStar } from '../events/misc'

const opts = { bodyMaxLength: 500 }
const repo = { full_name: 'org/repo' }

describe('renderCreate / renderDelete', () => {
  it('create a branch', () => {
    expect(renderCreate({ repository: repo, ref: 'feature', ref_type: 'branch', sender: { login: 'alice' } }, opts))
      .toBe('alice created branch org/repo:feature')
  })
  it('create a tag uses @', () => {
    expect(renderCreate({ repository: repo, ref: 'v1', ref_type: 'tag', sender: { login: 'alice' } }, opts))
      .toBe('alice created tag org/repo@v1')
  })
  it('delete a branch', () => {
    expect(renderDelete({ repository: repo, ref: 'feature', ref_type: 'branch', sender: { login: 'alice' } }, opts))
      .toBe('alice deleted branch org/repo:feature')
  })
})

describe('renderFork', () => {
  it('renders forker + source + destination + total', () => {
    expect(renderFork({ repository: { full_name: 'org/repo', forks_count: 7 }, sender: { login: 'alice' }, forkee: { full_name: 'alice/repo' } }, opts))
      .toBe('alice forked org/repo to alice/repo (total 7 forks)')
  })
})

describe('renderMilestone', () => {
  const base = { repository: repo, sender: { login: 'alice' }, milestone: { title: 'v2' } }
  it('opened', () => {
    expect(renderMilestone({ ...base, action: 'opened' }, opts)).toBe('alice opened milestone v2 for org/repo')
  })
  it('closed', () => {
    expect(renderMilestone({ ...base, action: 'closed' }, opts)).toBe('alice closed milestone v2 for org/repo')
  })
  it('other actions -> null', () => {
    expect(renderMilestone({ ...base, action: 'edited' }, opts)).toBeNull()
  })
})

describe('renderStar', () => {
  it('created: starrer + repo + total', () => {
    expect(renderStar({ action: 'created', repository: { full_name: 'org/repo', stargazers_count: 42 }, sender: { login: 'alice' } }, opts))
      .toBe('alice starred org/repo (total 42 stargazers)')
  })
  it('deleted (unstar) -> null', () => {
    expect(renderStar({ action: 'deleted', repository: { full_name: 'org/repo', stargazers_count: 41 }, sender: { login: 'alice' } }, opts)).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/plugins/github/__tests__/events-misc.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

Create `src/plugins/github/events/misc.ts`:

```ts
import type { EventRenderer } from '../types'

/** Shared branch/tag create|delete formatter. */
function renderReference(payload: any, verb: string): string {
  const { repository, ref, ref_type, sender } = payload
  const refName = `${repository.full_name}${ref_type === 'tag' ? '@' : ':'}${ref}`
  return `${sender.login} ${verb} ${ref_type} ${refName}`
}

export const renderCreate: EventRenderer = (payload) => renderReference(payload, 'created')
export const renderDelete: EventRenderer = (payload) => renderReference(payload, 'deleted')

export const renderFork: EventRenderer = (payload) => {
  const { repository, sender, forkee } = payload
  return `${sender.login} forked ${repository.full_name} to ${forkee.full_name} (total ${repository.forks_count} forks)`
}

export const renderMilestone: EventRenderer = (payload) => {
  const { action, repository, milestone, sender } = payload
  if (!['opened', 'closed'].includes(action)) return null
  return `${sender.login} ${action} milestone ${milestone.title} for ${repository.full_name}`
}

export const renderStar: EventRenderer = (payload) => {
  if (payload.action !== 'created') return null
  const { repository, sender } = payload
  return `${sender.login} starred ${repository.full_name} (total ${repository.stargazers_count} stargazers)`
}
```

- [ ] **Step 4: 注册进 events/index.ts**

在 `src/plugins/github/events/index.ts` 的 import 区加 `import { renderCreate, renderDelete, renderFork, renderMilestone, renderStar } from './misc'`，并在 `renderers` 对象里加：
```ts
  create: renderCreate,
  delete: renderDelete,
  fork: renderFork,
  milestone: renderMilestone,
  star: renderStar,
```

- [ ] **Step 5: 跑测试 + 类型检查**

Run: `npx vitest run src/plugins/github/__tests__/events-misc.test.ts`
Expected: PASS。
Run: `npx tsc --noEmit -p .`
Expected: 无新错误。

- [ ] **Step 6: Commit**

```bash
git add src/plugins/github/events/misc.ts src/plugins/github/__tests__/events-misc.test.ts src/plugins/github/events/index.ts
git commit -m "feat(github): create/delete/fork/milestone/star renderers"
```

---

### Task 6: 端到端分派集成测试 + 收口

**Files:**
- Create: `src/plugins/github/__tests__/webhook-dispatch.test.ts`

**Interfaces:**
- Consumes: `handleWebhook`（Task 1 改后签名）、全部 renderers

- [ ] **Step 1: 写集成测试（验证非 push 事件经 handleWebhook 正确分派 + 截断生效）**

Create `src/plugins/github/__tests__/webhook-dispatch.test.ts`:

```ts
import { createHmac } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { handleWebhook, type WebhookDeps } from '../webhook'

const secret = 's3cr3t'
const deps: WebhookDeps = { getSecret: async () => secret, targets: () => ['mock:1'] }

// Build a signed urlencoded request for a given event + payload object.
function sign(event: string, payloadObj: any) {
  const json = JSON.stringify(payloadObj)
  const raw = 'payload=' + encodeURIComponent(json)
  const headers = {
    'x-github-event': event,
    'x-github-hook-id': '1',
    'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex'),
  }
  return { raw, body: { payload: json }, headers }
}

describe('handleWebhook dispatch for non-push events', () => {
  it('routes an issues/opened event to renderIssues', async () => {
    const { raw, body, headers } = sign('issues', {
      action: 'opened',
      repository: { full_name: 'org/repo' },
      sender: { login: 'alice' },
      issue: { number: 3, title: 'Bug', body: 'boom', user: { type: 'User' } },
    })
    const r = await handleWebhook(headers, raw, body, deps)
    expect(r.status).toBe(200)
    expect(r.targets).toEqual(['mock:1'])
    expect(r.message).toBe('alice opened an issue org/repo#3\nTitle: Bug\nboom')
  })

  it('applies bodyMaxLength truncation via renderOptions', async () => {
    const { raw, body, headers } = sign('issues', {
      action: 'opened',
      repository: { full_name: 'org/repo' },
      sender: { login: 'alice' },
      issue: { number: 3, title: 'T', body: 'abcdefghij', user: { type: 'User' } },
    })
    const r = await handleWebhook(headers, raw, body, deps, { bodyMaxLength: 3 })
    expect(r.message).toBe('alice opened an issue org/repo#3\nTitle: T\nabc…')
  })

  it('a subscribed but unrendered event (e.g. gollum) yields 200 with no message', async () => {
    const { raw, body, headers } = sign('gollum', {
      repository: { full_name: 'org/repo' }, sender: { login: 'alice' },
    })
    const r = await handleWebhook(headers, raw, body, deps)
    expect(r.status).toBe(200)
    expect(r.message).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认通过**

Run: `npx vitest run src/plugins/github/__tests__/webhook-dispatch.test.ts`
Expected: PASS（3 用例）。若某条失败，核对对应渲染器输出与 Task 1 的 handleWebhook renderOptions 传参。

- [ ] **Step 3: 全量 github 测试 + 类型检查**

Run: `npx vitest run src/plugins/github`
Expected: 全部测试文件 PASS（Phase 1 + Phase 2 全绿）。
Run: `npx tsc --noEmit -p .`
Expected: 无新错误。

- [ ] **Step 4: Commit**

```bash
git add src/plugins/github/__tests__/webhook-dispatch.test.ts
git commit -m "test(github): end-to-end dispatch for non-push events"
```

---

## Self-Review

**Spec coverage（对照更新后的 spec 事件表）：**
- push（Phase 1）✅；`issues`(opened/closed/reopened/transferred)→Task 3 ✅；`issue_comment`/`commit_comment`/`pull_request_review_comment`→Task 2 ✅；`pull_request_review`(submitted)→Task 4 ✅；`pull_request`(opened/closed/reopened/review_requested/converted_to_draft/ready_for_review)→Task 4 ✅；`create`/`delete`/`fork`/`milestone`/`star`→Task 5 ✅。
- 正文纯文本 `cleanBody`（去 footer/HTML注释/合并空行/trim）+ `bodyMaxLength` 截断→Task 1 ✅；渲染器均用之。
- 分派按 x-github-event + 内部 action switch→各渲染器 ✅；端到端分派→Task 6 ✅。
- 交互对象不做（Phase 4）→各渲染器只返回文本 ✅。

**Placeholder 扫描：** 无 TBD/TODO；每步含完整代码与命令。✅

**类型一致性：** `EventRenderer = (payload, opts: RenderOptions) => Fragment | null`（Task 1）在 Task 2-5 一致；`cleanBody(source, maxLength)`/`issueName(repository, issue)`（Task 1）签名在各渲染器一致调用；`handleWebhook(...renderOptions?)`（Task 1）在 Task 6 使用。push.ts 的 `(payload)=>` 仍可赋给新类型（少参可赋）。✅

## 已知边界 / 后续 Phase

- 交互（引用回复 react/comment/close、link/shot/merge）+ history + `replyTimeout` → Phase 4。
- OAuth + 订阅管理命令（含 repo 改名迁移）→ Phase 3。
- `github.user` 卡片 → Phase 5。
