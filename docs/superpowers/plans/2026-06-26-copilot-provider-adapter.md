# Copilot Provider Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 GitHub Copilot 作为 SILI LLM 插件的一个 provider 后端接入，复用现有 `OpenAIProvider` 的全部流式逻辑。

**Architecture:** `CopilotProvider extends OpenAIProvider`，仅替换底层 client 为内联的 `GithubCopilotAI`（Copilot 对外是 OpenAI 协议，用 GitHub OAuth token 换短期 Copilot token 注入鉴权）。给 `OpenAIProvider` 开一个 `createClient` 钩子供子类替换 client。首次请求前一次性 `getCopilotInternalUser()` 自动探测 plan 并切到对的 endpoint。

**Tech Stack:** TypeScript、koishi、`openai@^6.17.0` SDK、vitest。

## Global Constraints

- 不引入 `github-copilot-ai` npm 包（它依赖 `openai@^5`，与本项目 `openai@^6.17.0` 冲突）。客户端代码内联进仓库。
- vendored 客户端**行为零改动**，端点切换逻辑（`getBaseURLByPlan` / `setCopilotInternalUser`）原样保留。允许的改动仅限：(a) import 指向本项目的 `openai@6`；(b) 文件头加来源/MIT 署名注释；(c) 两处不改变行为的清理 —— 构造函数里 `let baseURL` 改 `const baseURL`，`setCopilotInternalAuth` 删掉第二个 `if` 里重复的 `!auth.token` 死判（上一行已判过）。这两处已直接写进下方 Task 1 的代码，按代码照抄即可。
- 路径别名：`@/*` → `src/*`，`~/*` → `src/plugins/*`，`$utils/*` → `src/utils/*`。
- 测试位于被测代码同级的 `__tests__/`，用 vitest（`describe/it/expect`，from `'vitest'`）。
- 类型检查命令：`npx tsc --noEmit -p .`。
- 代码注释用英文。

---

### Task 1: 内联 Copilot 客户端 + token 缓存单测

**Files:**
- Create: `src/plugins/llm/providers/copilot-client.ts`
- Test: `src/plugins/llm/providers/__tests__/copilot-client.test.ts`

**Interfaces:**
- Consumes: `openai@6` 的 `ClientOptions`、`OpenAI`。
- Produces:
  - `class GithubCopilotAI extends OpenAI`，构造 `constructor(options?: ClientOptions & { copilotPlan?: 'default' | 'individual' | 'enterprise' })`
  - `async getCopilotInternalUser(): Promise<CopilotInternalUser>`
  - `async getCopilotInternalAuth(): Promise<CopilotInternalAuth>`
  - `setCopilotInternalAuth(auth: CopilotInternalAuth | null): CopilotInternalAuth | null`
  - `interface CopilotInternalUser`、`interface CopilotInternalAuth`

- [ ] **Step 1: 创建 vendored 客户端文件**

Create `src/plugins/llm/providers/copilot-client.ts` with exactly:

```ts
import { ClientOptions, OpenAI } from 'openai'

/**
 * GitHub Copilot AI client.
 *
 * Vendored verbatim from the `github-copilot-ai` package so it links against
 * this project's own `openai@6` (the published package depends on `openai@5`,
 * which would coexist as a second incompatible copy). Logic is unchanged —
 * only the import targets this repo's SDK.
 *
 * @author dragon-fish <dragon-fish@qq.com>
 * @license MIT
 * @see https://github.com/dragon-fish/github-copilot-ai
 */
export class GithubCopilotAI extends OpenAI {
  #copilotInternalUser: CopilotInternalUser | null = null
  #copilotInternalAuth: CopilotInternalAuth | null = null
  static defaultHeaders: Record<string, string> = {
    'copilot-integration-id': 'vscode-chat',
    'editor-plugin-version': 'copilot-chat/0.28.0',
    'editor-version': 'vscode/1.100.0-insider',
    'openai-intent': 'conversation-panel',
    'user-agent': 'GitHubCopilotChat/0.28.0',
  }

  constructor(
    options: ClientOptions & {
      copilotPlan?: 'default' | 'individual' | 'enterprise'
    } = {}
  ) {
    const baseURL = GithubCopilotAI.getBaseURLByPlan(
      options.copilotPlan || 'default'
    )
    super({
      ...options,
      baseURL,
      defaultHeaders: GithubCopilotAI.defaultHeaders,
      fetch: async (url, options) => {
        const auth = await this.getCopilotInternalAuth()
        const request = new Request(url, options)
        request.headers.set('Authorization', `Bearer ${auth.token}`)
        return fetch(request)
      },
    })
  }

  static getBaseURLByPlan(
    copilotPlan: 'individual' | 'enterprise' | string = 'default'
  ): string {
    if (copilotPlan === 'enterprise') {
      return 'https://api.enterprise.githubcopilot.com/'
    } else if (copilotPlan === 'individual') {
      return 'https://api.individual.githubcopilot.com/'
    } else {
      return 'https://api.githubcopilot.com/'
    }
  }

  async getCopilotInternalUser() {
    if (this.#copilotInternalUser && this.#copilotInternalUser.assigned_date) {
      return this.#copilotInternalUser
    }
    const res = await fetch('https://api.github.com/copilot_internal/user', {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    }).then((res) => res.json() as Promise<CopilotInternalUser>)
    return this.setCopilotInternalUser(res)!
  }
  setCopilotInternalUser(user: null): null
  setCopilotInternalUser(user: CopilotInternalUser): CopilotInternalUser | null
  setCopilotInternalUser(
    user: CopilotInternalUser | null
  ): CopilotInternalUser | null {
    if (!user) {
      this.#copilotInternalUser = null
      return null
    }
    if (!user.assigned_date) {
      throw new Error('Invalid payload', { cause: user })
    }
    this.#copilotInternalUser = user
    this.baseURL = GithubCopilotAI.getBaseURLByPlan(
      user.copilot_plan || 'default'
    )
    return this.#copilotInternalUser
  }

  async getCopilotInternalAuth() {
    if (
      this.#copilotInternalAuth &&
      this.#copilotInternalAuth.expires_at > Date.now() / 1000
    ) {
      return this.#copilotInternalAuth
    }
    const res = await fetch(
      'https://api.github.com/copilot_internal/v2/token',
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      }
    ).then((res) => res.json() as Promise<CopilotInternalAuth>)
    return this.setCopilotInternalAuth(res)!
  }
  setCopilotInternalAuth(
    auth: CopilotInternalAuth | null
  ): CopilotInternalAuth | null {
    if (!auth) {
      this.#copilotInternalAuth = null
      return null
    }
    if (!auth.token || !auth.expires_at) {
      throw new Error('Invalid payload', { cause: auth })
    }
    if (Date.now() / 1000 > auth.expires_at) {
      this.#copilotInternalAuth = null
      return null
    }
    this.#copilotInternalAuth = auth
    return this.#copilotInternalAuth
  }
}

export interface CopilotInternalUser {
  access_type_sku: string
  analytics_tracking_id: string
  assigned_date: string
  can_signup_for_limited: boolean
  chat_enabled: boolean
  copilot_plan: 'default' | 'individual' | 'enterprise'
  organization_login_list: unknown[]
  organization_list: unknown[]
}

export interface CopilotInternalAuth {
  annotations_enabled: boolean
  chat_enabled: boolean
  chat_jetbrains_enabled: boolean
  code_quote_enabled: boolean
  code_review_enabled: boolean
  codesearch: boolean
  copilotignore_enabled: boolean
  endpoints: {
    api: string
    'origin-tracker': string
    proxy: string
    telemetry: string
  }
  expires_at: number
  individual: boolean
  limited_user_quotas: null | any
  limited_user_reset_date: null | string
  prompt_8k: boolean
  public_suggestions: string
  refresh_in: number
  sku: string
  snippy_load_test_enabled: boolean
  telemetry: string
  token: string
  tracking_id: string
  vsc_electron_fetcher_v2: boolean
  xcode: boolean
  xcode_chat: boolean
}
```

- [ ] **Step 2: 写 token 缓存失败测试**

Create `src/plugins/llm/providers/__tests__/copilot-client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { GithubCopilotAI } from '../copilot-client'

// Minimal valid token-endpoint payload; only token + expires_at matter.
const authPayload = (expiresAt: number) => ({
  token: `tok-${expiresAt}`,
  expires_at: expiresAt,
})

describe('GithubCopilotAI token cache', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-26T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('fetches once then reuses an unexpired token', async () => {
    const nowSec = Date.now() / 1000
    fetchSpy = vi.fn(async () => ({
      json: async () => authPayload(nowSec + 3600),
    }))
    vi.stubGlobal('fetch', fetchSpy)

    const client = new GithubCopilotAI({ apiKey: 'oauth-token' })
    const a1 = await client.getCopilotInternalAuth()
    const a2 = await client.getCopilotInternalAuth()

    expect(a1.token).toBe(a2.token)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('refetches after the token expires', async () => {
    const t0 = Date.now() / 1000
    fetchSpy = vi.fn(async () => ({
      json: async () => authPayload(Date.now() / 1000 + 10),
    }))
    vi.stubGlobal('fetch', fetchSpy)

    const client = new GithubCopilotAI({ apiKey: 'oauth-token' })
    await client.getCopilotInternalAuth()
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date((t0 + 20) * 1000))
    await client.getCopilotInternalAuth()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('setCopilotInternalAuth returns null for null / already-expired payloads', () => {
    const client = new GithubCopilotAI({ apiKey: 'oauth-token' })
    expect(client.setCopilotInternalAuth(null)).toBeNull()
    const expired = { token: 't', expires_at: Date.now() / 1000 - 1 } as any
    expect(client.setCopilotInternalAuth(expired)).toBeNull()
  })

  it('setCopilotInternalAuth throws on payloads missing token/expires_at', () => {
    const client = new GithubCopilotAI({ apiKey: 'oauth-token' })
    expect(() => client.setCopilotInternalAuth({} as any)).toThrow(
      'Invalid payload'
    )
  })
})
```

- [ ] **Step 3: 跑测试确认通过**

Run: `npx vitest run src/plugins/llm/providers/__tests__/copilot-client.test.ts`
Expected: PASS（4 个用例全绿）。若 `this.baseURL =` / `this.apiKey` 报类型错说明 openai@6 字段不可变——但已核实二者均为 public 可变 `string` 字段，不应发生。

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit -p .`
Expected: 无新增错误。

- [ ] **Step 5: 提交**

```bash
git add src/plugins/llm/providers/copilot-client.ts src/plugins/llm/providers/__tests__/copilot-client.test.ts
git commit -m "feat(llm): vendor GitHub Copilot OpenAI client"
```

---

### Task 2: 给 OpenAIProvider 开 createClient 钩子

**Files:**
- Modify: `src/plugins/llm/providers/openai.ts:28-34`

**Interfaces:**
- Produces: `protected createClient(options: ClientOptions): OpenAI`；`protected client: OpenAI`（供 `CopilotProvider` 覆写/访问）。

- [ ] **Step 1: 把 client 字段改为 protected 并抽出 createClient**

In `src/plugins/llm/providers/openai.ts`, change the class head from:

```ts
export class OpenAIProvider extends LLMProviderBase {
  private client: OpenAI

  constructor(options: ClientOptions) {
    super()
    this.client = new OpenAI(options)
  }
```

to:

```ts
export class OpenAIProvider extends LLMProviderBase {
  protected client: OpenAI

  constructor(options: ClientOptions) {
    super()
    this.client = this.createClient(options)
  }

  /** Build the underlying OpenAI-protocol client. Subclasses override to
   *  swap in a compatible client (e.g. Copilot). */
  protected createClient(options: ClientOptions): OpenAI {
    return new OpenAI(options)
  }
```

- [ ] **Step 2: 跑现有 provider 测试确认无回归**

Run: `npx vitest run src/plugins/llm/providers/__tests__`
Expected: PASS（既有 openai/anthropic adapter + aggregator 测试全绿）。

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit -p .`
Expected: 无新增错误。

- [ ] **Step 4: 提交**

```bash
git add src/plugins/llm/providers/openai.ts
git commit -m "refactor(llm): extract createClient hook on OpenAIProvider"
```

---

### Task 3: CopilotProvider + 接线到 index.tsx

**Files:**
- Create: `src/plugins/llm/providers/copilot.ts`
- Modify: `src/plugins/llm/index.tsx`（`ProviderConfig` 联合 line 93-107；provider 实例化 switch line 342-360；import 区）
- Test: `src/plugins/llm/providers/__tests__/copilot.test.ts`

**Interfaces:**
- Consumes: `OpenAIProvider.createClient`（Task 2）、`GithubCopilotAI` / `getCopilotInternalUser`（Task 1）。
- Produces: `class CopilotProvider extends OpenAIProvider`，构造签名同父类 `constructor(options: ClientOptions)`。`ProviderConfig` 新增 `type: 'copilot'` 分支。

- [ ] **Step 1: 写 CopilotProvider 测试**

Create `src/plugins/llm/providers/__tests__/copilot.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

import { CopilotProvider } from '../copilot'
import { GithubCopilotAI } from '../copilot-client'

describe('CopilotProvider', () => {
  it('builds a GithubCopilotAI as its underlying client', () => {
    const provider = new CopilotProvider({ apiKey: 'oauth-token' })
    // `client` is protected; reach in for the wiring assertion only.
    const client = (provider as unknown as { client: unknown }).client
    expect(client).toBeInstanceOf(GithubCopilotAI)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/plugins/llm/providers/__tests__/copilot.test.ts`
Expected: FAIL，报无法解析 `../copilot`（文件还没建）。

- [ ] **Step 3: 创建 CopilotProvider**

Create `src/plugins/llm/providers/copilot.ts`:

```ts
import { ClientOptions, OpenAI } from 'openai'

import {
  ChatCompletionFeatures,
  ChatCompletionOptions,
  ChatMessage,
  StreamChatDelta,
} from './_base'
import { GithubCopilotAI } from './copilot-client'
import { OpenAIProvider } from './openai'

/**
 * GitHub Copilot provider. Copilot speaks the OpenAI protocol, so the entire
 * streaming / tool-call / usage pipeline is inherited from OpenAIProvider —
 * only the underlying client and a one-shot plan probe differ.
 */
export class CopilotProvider extends OpenAIProvider {
  #planDetected?: Promise<void>

  protected createClient(options: ClientOptions): OpenAI {
    return new GithubCopilotAI(options)
  }

  /**
   * Probe the Copilot plan exactly once per process, which switches the
   * client baseURL to the plan-specific endpoint (different endpoints have
   * different rate-limit policies). Best-effort: on failure we keep the
   * default endpoint and let the real request surface auth errors.
   */
  private ensurePlanDetected(): Promise<void> {
    if (!this.#planDetected) {
      this.#planDetected = (this.client as GithubCopilotAI)
        .getCopilotInternalUser()
        .then(() => {})
        .catch(() => {})
    }
    return this.#planDetected
  }

  async *streamChatCompletion(
    messages: ChatMessage[],
    options: ChatCompletionOptions,
    features?: ChatCompletionFeatures
  ): AsyncGenerator<StreamChatDelta, void, unknown> {
    await this.ensurePlanDetected()
    yield* super.streamChatCompletion(messages, options, features)
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/plugins/llm/providers/__tests__/copilot.test.ts`
Expected: PASS。

- [ ] **Step 5: ProviderConfig 联合加 copilot 分支**

In `src/plugins/llm/index.tsx`, the `ProviderConfig` union currently ends with the anthropic branch (around line 101-107). Add a third branch so it reads:

```ts
  | {
      name: string
      type: 'anthropic'
      options: AnthropicClientOptions
      model?: string
      maxTokens?: number
    }
  | {
      name: string
      type: 'copilot'
      options: ClientOptions
      model?: string
      maxTokens?: number
    }
```

(`ClientOptions` from `openai` is already imported in this file — it's used by the openai branch.)

- [ ] **Step 6: import CopilotProvider 并在 switch 加 case**

In `src/plugins/llm/index.tsx`, add the import next to the existing provider imports (near line 20-21):

```ts
import { CopilotProvider } from './providers/copilot'
```

Then in the provider-instantiation `switch` (around line 343), add a case before `default`:

```ts
        case 'copilot':
          this.providers.set(
            providerConfig.name,
            new CopilotProvider(providerConfig.options)
          )
          break
```

- [ ] **Step 7: 类型检查**

Run: `npx tsc --noEmit -p .`
Expected: 无新增错误。

- [ ] **Step 8: 提交**

```bash
git add src/plugins/llm/providers/copilot.ts src/plugins/llm/providers/__tests__/copilot.test.ts src/plugins/llm/index.tsx
git commit -m "feat(llm): add CopilotProvider and wire it into the plugin"
```

---

### Task 4: parseLLMProviders 支持 copilot 类型

**Files:**
- Modify: `src/utils/parseLLMProviders.ts`（type 分支 line 44-62；顶部约定注释 line 3-19）
- Test: `src/utils/__tests__/parseLLMProviders.test.ts`

**Interfaces:**
- Consumes: `ProviderConfig` 的 `type: 'copilot'` 分支（Task 3）。

- [ ] **Step 1: 写 copilot 解析测试**

In `src/utils/__tests__/parseLLMProviders.test.ts`, add inside the top-level `describe('parseLLMProviders', ...)` block (after the existing `it` cases, before the nested `describe`):

```ts
  it('parses a copilot provider with apiKey as the GitHub OAuth token', () => {
    const out = parseLLMProviders({
      LLM_PROVIDER_0_NAME: 'copilot',
      LLM_PROVIDER_0_TYPE: 'copilot',
      LLM_PROVIDER_0_API_KEY: 'gho_token',
    })
    expect(out).toEqual([
      {
        name: 'copilot',
        model: undefined,
        maxTokens: undefined,
        type: 'copilot',
        options: { apiKey: 'gho_token' },
      },
    ])
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/utils/__tests__/parseLLMProviders.test.ts`
Expected: FAIL —— copilot provider 当前未被解析，`out` 为 `[]`。

- [ ] **Step 3: 加 copilot 解析分支**

In `src/utils/parseLLMProviders.ts`, after the `anthropic` branch (around line 53-62), add:

```ts
    } else if (type === 'copilot') {
      providers.push({
        ...base,
        type: 'copilot',
        options: {
          ...(baseURL && { baseURL }),
          ...(apiKey && { apiKey }),
        },
      })
    }
```

- [ ] **Step 4: 同步顶部约定注释**

In `src/utils/parseLLMProviders.ts`, update the `LLM_PROVIDER_{N}_TYPE` line in the doc comment (line 8) and add a note. Change:

```
 *   LLM_PROVIDER_{N}_TYPE     — 'openai' | 'anthropic' (required)
```

to:

```
 *   LLM_PROVIDER_{N}_TYPE     — 'openai' | 'anthropic' | 'copilot' (required)
 *     For 'copilot', API_KEY is your GitHub OAuth token; BASE_URL is normally
 *     left unset (the endpoint is auto-detected from your Copilot plan).
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/utils/__tests__/parseLLMProviders.test.ts`
Expected: PASS（含新增用例）。

- [ ] **Step 6: 类型检查**

Run: `npx tsc --noEmit -p .`
Expected: 无新增错误。

- [ ] **Step 7: 提交**

```bash
git add src/utils/parseLLMProviders.ts src/utils/__tests__/parseLLMProviders.test.ts
git commit -m "feat(llm): parse copilot provider from env config"
```

---

## 端到端验证（全部任务后）

非自动化，需用户用真实 Copilot OAuth token 配置：

1. 在 `.env` 配一个 copilot provider：
   ```
   LLM_PROVIDER_N_NAME=copilot
   LLM_PROVIDER_N_TYPE=copilot
   LLM_PROVIDER_N_API_KEY=<GitHub OAuth token>
   ```
2. 按 `CLAUDE.local.md` 重启 `core`（`docker compose restart core`，约 10s）。
3. 群里 `chat` 指定 Copilot 供应的模型（如 `claude-sonnet-4`）跑一轮，确认流式输出正常。
4. 观察 core 日志确认首次请求触发了一次 `getCopilotInternalUser`、后续命中切好的 endpoint。
