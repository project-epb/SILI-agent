# Copilot Provider Adapter — Design

把 GitHub Copilot 作为 SILI LLM 插件的一个 provider 后端接入。Copilot 对外是 OpenAI 协议，
内部用 GitHub OAuth token 换取短期 Copilot token 注入鉴权头。本设计以「复用 `OpenAIProvider`」
为核心，改动面控制在 5 处。

来源参考：`github-copilot-ai`（@dragon-fish, MIT），其 `GithubCopilotAI extends OpenAI`。

## 目标

- SILI 能通过用户的 Copilot 订阅调用 Copilot 供应的模型（如 `claude-sonnet-4`、`gpt-*`、`gemini-*`）。
- 配置只需 `type: copilot` + GitHub OAuth token，endpoint / plan 全自动探测。
- 最大化复用现有 OpenAI provider 的流式聚合、`normalizeOptions`（Claude temperature 特判正好用得上）、
  `listModels`、usage 映射逻辑。

## 非目标

- 不在 SILI 内实现 GitHub device-flow 登录命令。用户用 `github-copilot-ai` 的 oauth 脚本预先拿到 OAuth token，
  填进配置即可。
- 不引入 `github-copilot-ai` npm 包（它依赖 `openai@^5`，会和 SILI 的 `openai@^6` 双份并存、类型不互通）。
  改为内联其客户端代码。

## 架构

`GithubCopilotAI` 本质是「换了 `fetch` 和 `baseURL` 的 OpenAI 客户端」，对外仍是标准 OpenAI 协议。
因此让 `CopilotProvider extends OpenAIProvider`，仅替换底层 client 构造，其余全部继承。

为支持子类替换 client，给 `OpenAIProvider` 开一个最小扩展点 `createClient`。

### 数据流

```
配置 LLM_PROVIDER_N_TYPE=copilot
    + LLM_PROVIDER_N_API_KEY=<GitHub OAuth token>
  ↓ parseLLMProviders
ProviderConfig { type: 'copilot', options: { apiKey } }
  ↓ index.tsx switch → new CopilotProvider(options)
CopilotProvider.createClient → new GithubCopilotAI(options)
  ↓ 首次 streamChatCompletion 前
ensurePlanDetected()  // 一次性 getCopilotInternalUser()，按 plan 切 baseURL，best-effort
  ↓ 之后
super.streamChatCompletion(...)  // 完全走 OpenAIProvider 流式逻辑
  ↓ 每个请求
GithubCopilotAI 自定义 fetch：用 OAuth token 换/缓存短期 Copilot token，注入 Authorization
```

## 改动文件

### 新增 `src/plugins/llm/providers/copilot-client.ts`

逐行内联 `github-copilot-ai` 的 `GithubCopilotAI` 类（含 `CopilotInternalUser` / `CopilotInternalAuth`
接口、`getBaseURLByPlan`、`setCopilotInternalUser` 按 `copilot_plan` 切 baseURL、`getCopilotInternalAuth`
按 `expires_at` 缓存短期 token、构造函数的自定义 fetch + 伪装 headers）。

**逻辑零改动**，唯一改动：

- import 指向 SILI 的 `openai@6`（`import { ClientOptions, OpenAI } from 'openai'`）。
- 文件头注释保留原作者 / MIT / 源仓库链接，标明系从 `github-copilot-ai` 内联。

endpoint 切换逻辑（`getBaseURLByPlan` / `setCopilotInternalUser`）原样保留 —— 不同端点频控不同，是有意为之。

### 新增 `src/plugins/llm/providers/copilot.ts`

```ts
export class CopilotProvider extends OpenAIProvider {
  #planDetected?: Promise<void>

  protected createClient(options: ClientOptions): OpenAI {
    return new GithubCopilotAI(options)
  }

  // 一次性探测 plan → 切到对的 baseURL，best-effort（失败留默认端点）。
  // memoize promise 保证整个进程只探测一次，之后所有请求复用切好的 baseURL。
  private ensurePlanDetected(): Promise<void> {
    if (!this.#planDetected) {
      this.#planDetected = (this.client as GithubCopilotAI)
        .getCopilotInternalUser()
        .then(() => {})
        .catch(() => {})
    }
    return this.#planDetected
  }

  async *streamChatCompletion(messages, options, features) {
    await this.ensurePlanDetected()
    yield* super.streamChatCompletion(messages, options, features)
  }
}
```

`createClient` 由父类构造函数调用（见下），故 `new GithubCopilotAI` 会拿到 provider config 里的 `options`。

### 改 `src/plugins/llm/providers/openai.ts`

抽出可覆写的 client 构造钩子，让 `CopilotProvider` 复用全部流式逻辑：

- `private client: OpenAI` → `protected client: OpenAI`
- 构造函数 `this.client = new OpenAI(options)` → `this.client = this.createClient(options)`
- 新增 `protected createClient(options: ClientOptions): OpenAI { return new OpenAI(options) }`

其余不动。

### 改 `src/plugins/llm/index.tsx`

- `ProviderConfig` 判别联合新增分支：
  ```ts
  | {
      name: string
      type: 'copilot'
      options: ClientOptions
      model?: string
      maxTokens?: number
    }
  ```
- provider 实例化 switch 新增：
  ```ts
  case 'copilot':
    this.providers.set(providerConfig.name, new CopilotProvider(providerConfig.options))
    break
  ```
- import `CopilotProvider`。

### 改 `src/utils/parseLLMProviders.ts`

- type 分支新增 `copilot`（与 `openai` 同构，options 仅含 `baseURL?` / `apiKey?`，apiKey = GitHub OAuth token）。
- 顶部约定注释里 `LLM_PROVIDER_{N}_TYPE` 的取值补上 `'copilot'`，并说明 copilot 的 `API_KEY` 是 GitHub OAuth token、
  baseURL 一般不填（由 plan 自动探测）。

## 错误处理

- `ensurePlanDetected` best-effort：探测失败（网络 / token 无效）静默吞错，留默认端点 `api.githubcopilot.com`，
  让真正的请求阶段去暴露 token 错误（与 OpenAI provider 行为一致，fail 在请求层）。
- token 换取失败 / 鉴权失败由 `GithubCopilotAI` 的自定义 fetch 抛出，沿用 OpenAI SDK 的错误冒泡，
  在 agent-loop 层按既有方式处理。

## 测试

- provider 流式层按项目惯例无单测（stream/abort 难 mock）。`CopilotProvider` 是薄子类，不新增流式测试。
- 新增 `src/plugins/llm/providers/__tests__/copilot-client.test.ts`：stub 全局 `fetch`，验证
  `getCopilotInternalAuth` 在 `expires_at` 未过期时复用缓存、过期后重新拉取；`setCopilotInternalAuth`
  对非法 payload（缺 token / 已过期）返回 null。
- `npx tsc --noEmit -p .` 类型检查通过。

## 验证

按 `CLAUDE.local.md` 重启 `core`，用真实 Copilot OAuth token 配一个 `type: copilot` provider，
群里 `chat`（指定 Copilot 供应的模型）跑一轮，确认端到端流式正常、plan 探测命中预期端点。
