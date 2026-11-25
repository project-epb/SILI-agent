import Anthropic, { ClientOptions } from '@anthropic-ai/sdk'

import {
  ChatCompletionFeatures,
  ChatCompletionOptions,
  ChatMessage,
  LLMProviderBase,
  StreamChatDelta,
  StreamFinishReason,
} from './_base'
import {
  AnthropicStreamAggregator,
  splitSystemMessages,
  toAnthropicMessages,
} from './anthropic-adapter'
import { ResolvedPart, resolveUserParts } from './images'

function mapAnthropicStopReason(reason: string | undefined): StreamFinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'tool_use':
      return 'tool_calls'
    case 'max_tokens':
      return 'length'
    default:
      return 'other'
  }
}

export class AnthropicProvider extends LLMProviderBase {
  private client: Anthropic

  constructor(options: ClientOptions) {
    super()
    this.client = new Anthropic(options)
  }

  async *streamChatCompletion(
    messages: ChatMessage[],
    options: ChatCompletionOptions,
    features?: ChatCompletionFeatures
  ): AsyncGenerator<StreamChatDelta, void, unknown> {
    const { system, rest } = splitSystemMessages(messages)
    const resolved = new Map<ChatMessage, ResolvedPart[]>()
    for (const m of rest)
      if (m.role === 'user' && m.images?.length)
        resolved.set(m, await resolveUserParts(m, this.vision, this.imageSource))

    const body: Anthropic.MessageCreateParams = {
      model: options.model,
      max_tokens: options.maxTokens ?? 1024,
      temperature: options.temperature ?? 0.8,
      system: system || undefined,
      messages: toAnthropicMessages(rest, resolved),
      stream: true,
    }

    if (options.tools?.length) {
      body.tools = options.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as any,
      }))
      if (options.toolChoice && options.toolChoice !== 'auto') {
        if (options.toolChoice === 'none') {
          body.tool_choice = { type: 'none' as any }
        } else if (options.toolChoice === 'required') {
          body.tool_choice = { type: 'any' }
        }
      }
    }

    if (features?.enableThinking) {
      // @ts-ignore extended thinking 字段
      body.thinking = {
        type: 'enabled',
        budget_tokens: features.thinkingBudget ?? options.maxTokens ?? 1024,
      }
    }

    const stream = this.client.messages.stream(body, {
      signal: features?.signal,
    })
    const aggregator = new AnthropicStreamAggregator()
    let stopReason: string | undefined

    for await (const event of stream) {
      switch (event.type) {
        case 'content_block_start': {
          const block = event.content_block as any
          aggregator.startBlock(event.index, {
            type: block.type,
            id: block.id,
            name: block.name,
          })
          break
        }

        case 'content_block_delta': {
          const delta = event.delta as any
          if (delta.type === 'text_delta') {
            // 不 trim — chunk 边界的空格不能丢
            const text = delta.text
            if (typeof text === 'string' && text.length > 0) {
              yield { kind: 'content', content: text }
            }
          } else if (delta.type === 'thinking_delta') {
            const text = delta.thinking
            if (typeof text === 'string' && text.length > 0) {
              yield { kind: 'reasoning_content', content: text }
            }
          } else if (delta.type === 'input_json_delta') {
            aggregator.appendInputJson(event.index, delta.partial_json ?? '')
          }
          break
        }

        case 'content_block_stop': {
          try {
            const finalized = aggregator.finalizeBlock(event.index)
            if (finalized) yield finalized
          } catch (e: any) {
            yield {
              kind: 'error',
              error: e instanceof Error ? e : new Error(String(e)),
            }
          }
          break
        }

        case 'message_delta': {
          const usage = (event as any).usage
          if (usage) {
            // Anthropic's `input_tokens` excludes cache reads/creates and
            // reports them as separate buckets; sum all three so
            // `promptTokens` reflects the true billed prompt size and the
            // cachedTokens/promptTokens hit-rate math is consistent with
            // OpenAI's `prompt_tokens` (which already includes cached).
            const inputRaw = usage.input_tokens ?? 0
            const cacheRead = usage.cache_read_input_tokens ?? 0
            const cacheCreate = usage.cache_creation_input_tokens ?? 0
            yield {
              kind: 'usage',
              usage: {
                promptTokens: inputRaw + cacheRead + cacheCreate,
                completionTokens: usage.output_tokens,
                cachedTokens:
                  typeof usage.cache_read_input_tokens === 'number'
                    ? cacheRead
                    : undefined,
              },
            }
          }
          const reason = (event as any).delta?.stop_reason
          if (reason) stopReason = reason
          break
        }
      }
    }

    yield { kind: 'finish', reason: mapAnthropicStopReason(stopReason) }
  }
}
