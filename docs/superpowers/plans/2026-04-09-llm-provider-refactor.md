# LLM Provider Pattern Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple `src/plugins/llm` from OpenAI SDK by introducing a provider abstraction with multi-instance support.

**Architecture:** Abstract `LLMProviderBase` defines a unified streaming interface. Concrete providers (OpenAI, Anthropic) encapsulate SDK-specific logic. `PluginLLM` holds a `Map<string, LLMProviderBase>` of named provider instances, using the first as default.

**Tech Stack:** TypeScript, Koishi framework, OpenAI SDK (`openai`), Anthropic SDK (`@anthropic-ai/sdk`)

**Spec:** `docs/superpowers/specs/2026-04-09-llm-provider-refactor-design.md`

---

### Task 1: Define Provider Interface and Types

**Files:**
- Rewrite: `src/plugins/llm/providers/_base.ts`

- [ ] **Step 1: Write the provider interface**

Replace the current `_base.ts` with the full type definitions and abstract class:

```typescript
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatCompletionOptions {
  model: string
  maxTokens?: number
  temperature?: number
  topP?: number
}

export interface ChatCompletionFeatures {
  enableThinking?: boolean
  thinkingBudget?: number
  enableSearch?: boolean
}

export interface ChatCompletionUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

export type StreamChatDelta =
  | { kind: 'reasoning_content'; content: string }
  | { kind: 'content'; content: string }
  | { kind: 'usage'; usage: ChatCompletionUsage }
  | { kind: 'error'; error: Error }

export abstract class LLMProviderBase {
  /**
   * Normalize options before sending to the API.
   * Override in subclasses to handle model-specific constraints
   * (e.g., Claude thinking mode requires temperature=1).
   */
  protected normalizeOptions(
    options: ChatCompletionOptions,
    features?: ChatCompletionFeatures
  ): ChatCompletionOptions {
    return options
  }

  abstract streamChatCompletion(
    messages: ChatMessage[],
    options: ChatCompletionOptions,
    features?: ChatCompletionFeatures
  ): AsyncGenerator<StreamChatDelta, void, unknown>
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `bunx tsc --noEmit --pretty 2>&1 | head -30`

There will be errors from `index.tsx` (it still imports the old type) — that's expected. Confirm `_base.ts` itself has no errors by checking the output doesn't mention `_base.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/plugins/llm/providers/_base.ts
git commit -m "feat(llm): define provider interface and types"
```

---

### Task 2: Implement OpenAI Provider

**Files:**
- Create: `src/plugins/llm/providers/openai.ts`

- [ ] **Step 1: Implement the OpenAI provider**

```typescript
import { ClientOptions, OpenAI } from 'openai'

import {
  ChatCompletionFeatures,
  ChatCompletionOptions,
  ChatMessage,
  LLMProviderBase,
  StreamChatDelta,
} from './_base'

export class OpenAIProvider extends LLMProviderBase {
  private client: OpenAI

  constructor(options: ClientOptions) {
    super()
    this.client = new OpenAI(options)
  }

  protected normalizeOptions(
    options: ChatCompletionOptions,
    features?: ChatCompletionFeatures
  ): ChatCompletionOptions {
    const model = options.model.toLowerCase()
    const isClaudeModel = model.includes('claude')
    const isKimiModel = model.includes('kimi')

    const result = { ...options }

    // Claude and Kimi thinking mode require temperature=1
    if (features?.enableThinking && (isClaudeModel || isKimiModel)) {
      result.temperature = 1
    }

    // Claude doesn't support top_p + temperature simultaneously
    if (isClaudeModel) {
      result.topP = undefined
    }

    return result
  }

  async *streamChatCompletion(
    messages: ChatMessage[],
    options: ChatCompletionOptions,
    features?: ChatCompletionFeatures
  ): AsyncGenerator<StreamChatDelta, void, unknown> {
    const opts = this.normalizeOptions(options, features)

    const body: Record<string, any> = {
      model: opts.model,
      messages,
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0.8,
      top_p: opts.topP ?? 0.8,
      stream: true,
      stream_options: { include_usage: true },
    }

    if (features?.enableThinking) {
      body.enable_thinking = true
      body.thinking_budget = features.thinkingBudget ?? options.maxTokens ?? 1024
    }

    if (features?.enableSearch) {
      body.enable_search = true
      body.web_search_options = {
        search_context_size: 'medium',
        user_location: {
          type: 'approximate',
          approximate: {
            country: 'CN',
            timezone: 'Asia/Shanghai',
          },
        },
      }
    }

    const stream = await this.client.chat.completions.create(body as any, {
      timeout: 90 * 1000,
    })

    for await (const chunk of stream) {
      if (chunk.usage) {
        yield {
          kind: 'usage',
          usage: {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          },
        }
      }

      const delta = (chunk as any).choices?.[0]?.delta
      if (!delta) continue

      const reasoning = delta.reasoning_content?.trim()
      if (reasoning) {
        yield { kind: 'reasoning_content', content: reasoning }
      }

      const content = delta.content?.trim()
      if (content) {
        yield { kind: 'content', content }
      }
    }
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `bunx tsc --noEmit --pretty 2>&1 | grep 'providers/openai'`

Expected: no errors mentioning `providers/openai.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/plugins/llm/providers/openai.ts
git commit -m "feat(llm): implement OpenAI-compatible provider"
```

---

### Task 3: Implement Anthropic Provider

**Files:**
- Create: `src/plugins/llm/providers/anthropic.ts`

- [ ] **Step 1: Implement the Anthropic provider**

```typescript
import Anthropic from '@anthropic-ai/sdk'

import {
  ChatCompletionFeatures,
  ChatCompletionOptions,
  ChatMessage,
  LLMProviderBase,
  StreamChatDelta,
} from './_base'

export class AnthropicProvider extends LLMProviderBase {
  private client: Anthropic

  constructor(options: Anthropic.ClientOptions) {
    super()
    this.client = new Anthropic(options)
  }

  async *streamChatCompletion(
    messages: ChatMessage[],
    options: ChatCompletionOptions,
    features?: ChatCompletionFeatures
  ): AsyncGenerator<StreamChatDelta, void, unknown> {
    // Extract system messages; Anthropic takes system as a separate param
    const systemMessages = messages.filter((m) => m.role === 'system')
    const nonSystemMessages = messages.filter((m) => m.role !== 'system')

    const system = systemMessages.map((m) => m.content).join('\n\n')

    const body: Anthropic.MessageCreateParams = {
      model: options.model,
      max_tokens: options.maxTokens ?? 1024,
      temperature: options.temperature ?? 0.8,
      system: system || undefined,
      messages: nonSystemMessages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      stream: true,
    }

    if (features?.enableThinking) {
      // Anthropic extended thinking uses a different parameter structure
      // @ts-ignore - extended thinking may not be in all SDK versions
      body.thinking = {
        type: 'enabled',
        budget_tokens: features.thinkingBudget ?? options.maxTokens ?? 1024,
      }
    }

    const stream = this.client.messages.stream(body)

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        const delta = event.delta as any
        if (delta.type === 'thinking_delta') {
          const text = delta.thinking?.trim()
          if (text) {
            yield { kind: 'reasoning_content', content: text }
          }
        } else if (delta.type === 'text_delta') {
          const text = delta.text?.trim()
          if (text) {
            yield { kind: 'content', content: text }
          }
        }
      } else if (event.type === 'message_delta') {
        const usage = (event as any).usage
        if (usage) {
          yield {
            kind: 'usage',
            usage: {
              promptTokens: usage.input_tokens,
              completionTokens: usage.output_tokens,
            },
          }
        }
      }
    }
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `bunx tsc --noEmit --pretty 2>&1 | grep 'providers/anthropic'`

Expected: no errors mentioning `providers/anthropic.ts` (ts-ignore covers the extended thinking field).

- [ ] **Step 3: Commit**

```bash
git add src/plugins/llm/providers/anthropic.ts
git commit -m "feat(llm): implement Anthropic provider"
```

---

### Task 4: Refactor PluginLLM to Use Provider Abstraction

**Files:**
- Modify: `src/plugins/llm/index.tsx`

This is the largest task. It rewrites `index.tsx` to remove all direct SDK usage and delegate to providers.

- [ ] **Step 1: Update imports and Config type**

Remove these imports from `index.tsx`:
```typescript
// REMOVE these lines:
import { Anthropic } from '@anthropic-ai/sdk'
import { ClientOptions, OpenAI } from 'openai'
import { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions.mjs'
import { CompletionUsage } from 'openai/resources/completions'
```

Update the import from `_base.ts`:
```typescript
import {
  ChatCompletionUsage,
  ChatMessage,
  LLMProviderBase,
} from './providers/_base'
```

Add provider imports:
```typescript
import { OpenAIProvider } from './providers/openai'
import { AnthropicProvider } from './providers/anthropic'
```

Replace the `Config` interface with:
```typescript
import type { ClientOptions } from 'openai'
import type Anthropic from '@anthropic-ai/sdk'

export type ProviderConfig =
  | {
      name: string
      type: 'openai'
      options: ClientOptions
    }
  | {
      name: string
      type: 'anthropic'
      options: Anthropic.ClientOptions
    }

export interface Config {
  providers: ProviderConfig[]
  model?: string
  reasoningModel?: string
  maxTokens?: number
  systemPrompt?: Partial<{
    default: string
    [key: string]: string
  }>
  modelAliases?: Record<string, string>
}
```

Update `OpenAIConversationLog` — replace `usage?: CompletionUsage` with:
```typescript
usage?: ChatCompletionUsage
```

Update `Context` interface augmentation — remove `openai: OpenAI` if present, keep `llm: PluginLLM`.

- [ ] **Step 2: Update the class properties and constructor**

Replace the class properties:
```typescript
// REMOVE:
readonly providers: Record<string, LLMProviderBase> = {}

// ADD:
readonly providers: Map<string, LLMProviderBase> = new Map()

get provider(): LLMProviderBase {
  const first = this.providers.values().next().value
  if (!first) throw new Error('No LLM provider configured')
  return first
}

useProvider(name: string): LLMProviderBase {
  const p = this.providers.get(name)
  if (!p) throw new Error(`LLM provider "${name}" not found`)
  return p
}
```

Replace the provider initialization block in the constructor (the `if (config.openaiOptions)` / `if (config.anthropicOptions)` / `if (config.googleGenAIOptions)` block):
```typescript
for (const providerConfig of config.providers) {
  switch (providerConfig.type) {
    case 'openai':
      this.providers.set(
        providerConfig.name,
        new OpenAIProvider(providerConfig.options)
      )
      break
    case 'anthropic':
      this.providers.set(
        providerConfig.name,
        new AnthropicProvider(providerConfig.options)
      )
      break
    default:
      this.logger.warn(
        `Unknown provider type: ${(providerConfig as any).type}`
      )
  }
}
```

- [ ] **Step 3: Update `llm/chat` action — add provider option and build provider call**

Add a new command option after the existing `debug` option:
```typescript
.option('provider', '<provider:string> AI service to use', {
  hidden: true,
  authority: 2,
})
```

Replace the request body construction and stream creation (the `const body: ChatCompletionCreateParamsStreaming = { ... }` block and the `const stream = await this.openai.chat.completions.create(body, ...)` block) with:

```typescript
const provider = options.provider
  ? this.useProvider(options.provider)
  : this.provider

const chatMessages: ChatMessage[] = [
  {
    role: 'system',
    content:
      typeof options.prompt === 'string'
        ? options.prompt
        : this.config.systemPrompt.default,
  },
  {
    role: 'system',
    content:
      'Conversation context: ' +
      JSON.stringify({
        user_name: userName,
        user_timezone: 'Asia/Shanghai',
        current_time: new Date().toISOString(),
      }),
  },
  ...histories,
  {
    role: 'user',
    content: userPrompt,
  },
]

const enableSearch =
  !!options.search || this.quickCheckShouldEnableSearch(userPrompt)

const stream = provider.streamChatCompletion(
  chatMessages,
  {
    model,
    maxTokens: this.config.maxTokens ?? 1024,
    temperature: 0.8,
    topP: 0.8,
  },
  {
    enableThinking: !!options.thinking,
    thinkingBudget: this.config.maxTokens ?? 1024,
    enableSearch,
  }
)
```

Note: the stream is now a sync call (returns `AsyncGenerator` directly), not an async call. Remove the `.catch()` on the stream creation. Instead, the existing `try { for await (const chunk of stream) { ... } }` block already handles errors.

- [ ] **Step 4: Update stream consumption loop**

Replace the stream reading logic inside the `try { for await ... }` block. The old code reads `chunk.choices[0].delta` and `chunk.usage`. The new code reads `StreamChatDelta`:

```typescript
try {
  for await (const delta of stream) {
    if (delta.kind === 'usage') {
      usage = delta.usage
      continue
    }
    if (delta.kind === 'error') {
      throw delta.error
    }

    if (delta.kind === 'reasoning_content') {
      const thinking = delta.content
      fullThinking += thinking
      if (shouldSendThinking) {
        const { text, nextIndex } = this.splitContent(
          fullThinking,
          sendThinkingFromIndex
        )
        sendThinkingFromIndex = nextIndex
        if (text) {
          this.logger.info('[chat] thinking:', text)
          stopEmojiReaction()
          ;[lastMessageId = lastMessageId] = await session.sendQueued(
            <>
              {lastMessageId && <quote id={lastMessageId}></quote>}
              [内心独白] {text}
            </>
          )
        }
      }
    }

    if (delta.kind === 'content') {
      const content = delta.content
      // End thinking phase
      if (!thinkingEnd) {
        thinkingEnd = true
        this.logger.info('[chat] think end:', fullThinking)
        if (
          fullThinking &&
          sendThinkingFromIndex < fullThinking.length &&
          shouldSendThinking
        ) {
          stopEmojiReaction()
          ;[lastMessageId = lastMessageId] = await session.sendQueued(
            <>
              {lastMessageId && <quote id={lastMessageId}></quote>}
              [内心独白] {fullThinking.slice(sendThinkingFromIndex)}
            </>
          )
        }
      }
      // Send content
      fullContent += content
      const { text, nextIndex } = this.splitContent(
        fullContent,
        sendContentFromIndex
      )
      sendContentFromIndex = nextIndex
      if (text) {
        this.logger.info('[chat] sending:', text)
        stopEmojiReaction()
        ;[lastMessageId = lastMessageId] = await session.sendQueued(
          <>
            {lastMessageId && <quote id={lastMessageId}></quote>}
            {text}
          </>
        )
      }
    }
  }
}
```

Also update the `usage` variable type at declaration:
```typescript
// CHANGE:
let usage: CompletionUsage | undefined
// TO:
let usage: ChatCompletionUsage | undefined
```

- [ ] **Step 5: Update `llm.models` command to TODO placeholder**

Replace the `llm.models` action body:
```typescript
this.ctx
  .command('llm.models', 'List all models', { authority: 3 })
  .action(async () => {
    // TODO: implement per-provider model listing
    return 'This command is not yet available in the new provider architecture.'
  })
```

- [ ] **Step 6: Remove systemPrompt defaults for removed sub-plugins**

In the constructor's `defaultConfigs`, remove the `channelSummary` and `censor` entries:
```typescript
const defaultConfigs: Partial<Config> = {
  model: 'gpt-4o-mini',
  reasoningModel: 'gpt-o1-mini',
  maxTokens: 8192,
  systemPrompt: {
    default: PluginLLM.readPromptFile('SILI-v5.prompt.md'),
  },
}
```

- [ ] **Step 7: Verify TypeScript compiles**

Run: `bunx tsc --noEmit --pretty`

Fix any remaining type errors. Common things to check:
- `usage` field in database create call should still work (JSON column accepts any shape)
- `histories` from `getChatHistoriesById` returns `{ role, content }[]` which matches `ChatMessage[]`
- Remove the `cache_control` type annotations from `getChatHistoriesById` return type (no longer needed since provider handles this internally)

- [ ] **Step 8: Commit**

```bash
git add src/plugins/llm/index.tsx
git commit -m "refactor(llm): decouple from SDK, use provider abstraction"
```

---

### Task 5: Update Entry Point

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Replace plugin import and registration**

Change the import:
```typescript
// CHANGE:
import PluginOpenAi from '~/openai'
// TO:
import PluginLLM from '~/llm'
```

Replace the plugin registration:
```typescript
// CHANGE:
ctx.plugin(PluginOpenAi, {
  openaiOptions: {
    baseURL: env.OPENAI_BASE_RUL,
    apiKey: env.OPENAI_API_KEY,
  },
  maxTokens: 4096,
  recordsPerChannel: 50,
  model: env.OPENAI_MODEL || 'gpt-4o',
  reasoningModel: env.OPENAI_REASONING_MODEL || 'deepseek-r1',
})

// TO:
ctx.plugin(PluginLLM, {
  providers: [
    {
      name: 'openai',
      type: 'openai' as const,
      options: {
        baseURL: env.OPENAI_BASE_RUL,
        apiKey: env.OPENAI_API_KEY,
      },
    },
  ],
  maxTokens: 4096,
  model: env.OPENAI_MODEL || 'gpt-4o',
  reasoningModel: env.OPENAI_REASONING_MODEL || 'deepseek-r1',
})
```

- [ ] **Step 2: Verify TypeScript compiles cleanly**

Run: `bunx tsc --noEmit --pretty`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "refactor: switch entry point from PluginOpenAi to PluginLLM"
```

---

### Task 6: Clean Up Old Plugin and Verify

**Files:**
- Delete: `src/plugins/openai/` (already deleted from working tree, stage the deletion)

- [ ] **Step 1: Stage deletion of old openai plugin**

```bash
git add src/plugins/openai/
```

This stages the deletion of the entire directory that was already removed from the working tree.

- [ ] **Step 2: Final TypeScript check**

Run: `bunx tsc --noEmit --pretty`

Expected: clean compile, no errors.

- [ ] **Step 3: Smoke test with dev server**

Run: `bun run dev`

Verify:
- Server starts without errors
- No import resolution failures in the log
- The `llm` plugin loads (look for initialization logs)

Stop the server after confirming (Ctrl+C).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove old openai plugin"
```
