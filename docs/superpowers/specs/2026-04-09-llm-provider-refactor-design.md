# LLM Plugin Provider Pattern Refactor

## Goal

Decouple `src/plugins/llm` from OpenAI SDK, introduce a provider abstraction so the chat logic is platform-agnostic.

## Scope

- Implement two providers: **OpenAI-compatible** and **Anthropic**
- Refactor `PluginLLM` to consume `LLMProviderBase` instead of calling SDK directly
- Remove sub-plugins `ChatCensorService` and `PluginChannelSummary` (no longer needed)
- Keep database table/field names unchanged (`openai_chat`, `openai_last_conversation_id`)
- Support multiple provider instances (e.g., openai + openrouter + volcengine), default to the first one, switchable per request

## Provider Interface

```typescript
// providers/_base.ts

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

export type StreamChatDelta =
  | { kind: 'reasoning_content'; content: string }
  | { kind: 'content'; content: string }
  | { kind: 'usage'; usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } }
  | { kind: 'error'; error: Error }

export abstract class LLMProviderBase {
  abstract streamChatCompletion(
    messages: ChatMessage[],
    options: ChatCompletionOptions,
    features?: ChatCompletionFeatures
  ): AsyncGenerator<StreamChatDelta, void, unknown>
}
```

- `options`: model parameters (model, maxTokens, temperature, topP)
- `features`: capability flags (thinking, search) - each provider handles what it supports, ignores the rest
- `StreamChatDelta`: unified stream output; removed `tool_call` (unused), added `usage` kind

## Provider Implementations

### OpenAI Provider (`providers/openai.ts`)

- Constructor receives `ClientOptions` (baseURL, apiKey)
- Builds `ChatCompletionCreateParamsStreaming` internally
- Maps features:
  - `enableThinking` -> `enable_thinking` + `thinking_budget`
  - `enableSearch` -> `enable_search` + `web_search_options` (hardcoded CN/Asia locale)
- Always sets `stream_options: { include_usage: true }`
- Handles `top_p` vs `temperature` conflict for Claude-compatible endpoints
- Yields `StreamChatDelta` from `chunk.choices[0].delta` (content, reasoning_content) and `chunk.usage`

### Anthropic Provider (`providers/anthropic.ts`)

- Constructor receives Anthropic SDK config
- Converts `ChatMessage[]` to Anthropic format: extracts system messages separately, user/assistant as messages array
- Processes Anthropic stream events (`content_block_delta`, `message_delta`, etc.)
- Maps features:
  - `enableThinking` -> extended thinking parameters
  - `enableSearch` -> ignored (not supported)
- Yields `StreamChatDelta` from stream events

## PluginLLM Changes

### Config

```typescript
import { ClientOptions } from 'openai'
import { Anthropic } from '@anthropic-ai/sdk'

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
  providers: ProviderConfig[]  // first one is the default
  model?: string
  reasoningModel?: string
  maxTokens?: number
  systemPrompt?: Partial<{ default: string; [key: string]: string }>
  modelAliases?: Record<string, string>
}
```

- `providers` is an array of named provider instances; the first entry is used by default
- Each entry has a discriminated union on `type`, so `options` gets proper type hints per SDK
- Removes `channelSummary` and `censor` from systemPrompt (sub-plugins removed)

### Constructor

- Iterates `config.providers`, instantiates each into `this.providers: Map<string, LLMProviderBase>`
- `get provider()` returns the default (first) provider
- `useProvider(name: string)` returns a specific provider by name
- SDK type imports (`ClientOptions`, `Anthropic.ClientOptions`) only appear in the Config type definition, not in runtime logic of index.tsx

### `llm/chat` Action

- Builds `ChatMessage[]` and `ChatCompletionOptions` + `ChatCompletionFeatures`
- Calls `this.provider.streamChatCompletion(messages, options, features)` (default provider)
- Supports optional `--provider <name>` flag to use a specific provider instance
- Consumes `StreamChatDelta` stream - same split/send logic as before
- Usage extracted from `{ kind: 'usage' }` delta instead of `CompletionUsage` type

### `llm.models` Command

- **TODO**: mark as placeholder. Provider interface does not yet include `listModels()`. Return a notice message for now.

### Unchanged

- `splitContent()` logic
- Emoji reaction / streaming send logic
- Database read/write (`openai_chat` table)
- `getChatHistoriesById()` / `isValidUserAssistantPairs()`
- `quickCheckShouldEnableSearch()`
- Conversation lock mechanism

## Entry Point (`src/index.ts`)

```typescript
import PluginLLM from '~/llm'

ctx.plugin(PluginLLM, {
  providers: [
    {
      name: 'openai',
      type: 'openai',
      options: { baseURL: env.OPENAI_BASE_RUL, apiKey: env.OPENAI_API_KEY },
    },
    // example: add more providers as needed
    // { name: 'openrouter', type: 'openai', options: { baseURL: '...', apiKey: '...' } },
    // { name: 'claude', type: 'anthropic', options: { apiKey: '...' } },
  ],
  maxTokens: 4096,
  model: env.OPENAI_MODEL || 'gpt-4o',
  reasoningModel: env.OPENAI_REASONING_MODEL || 'deepseek-r1',
})
```

## File Structure

```
src/plugins/llm/
├── index.tsx              // PluginLLM - no SDK imports
├── providers/
│   ├── _base.ts           // LLMProviderBase + types
│   ├── openai.ts          // OpenAI-compatible provider
│   └── anthropic.ts       // Anthropic provider
└── prompts/
    └── ...                // prompt files (unchanged)
```

## Removals

- `src/plugins/openai/` directory (already deleted from working tree, commit the deletion)
- `ChatCensorService` and `PluginChannelSummary` sub-plugins
- All OpenAI/Anthropic SDK imports from `index.tsx`
- `CompletionUsage` type import (replaced by `StreamChatDelta` usage kind)
