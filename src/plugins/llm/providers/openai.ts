import { ClientOptions, OpenAI } from 'openai'

import {
  ChatCompletionFeatures,
  ChatCompletionOptions,
  ChatMessage,
  LLMProviderBase,
  ModelInfo,
  StreamChatDelta,
  StreamFinishReason,
} from './_base'
import { OpenAIStreamAggregator, prepareOpenAIMessages } from './openai-adapter'

function mapOpenAIFinishReason(reason: string | undefined): StreamFinishReason {
  switch (reason) {
    case 'stop':
      return 'stop'
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls'
    case 'length':
      return 'length'
    default:
      return 'other'
  }
}

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

  async listModels(): Promise<ModelInfo[]> {
    const { data } = await this.client.models.list()
    return data
      .map((m: any) => ({
        id: m.id,
        name: m.display_name || m.name || undefined,
        ownedBy: m.owned_by || undefined,
        contextLength: m.context_length || undefined,
        ...this.extractPricing(m),
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  /**
   * Extract input/output pricing (per million tokens, USD) from various provider formats:
   * - OpenRouter: `pricing.prompt` / `pricing.completion` (per-token string)
   * - Zenmux: `pricings.prompt[0].value` / `pricings.completion[0].value` (per-million-token, array with conditions)
   * - Standard OpenAI: no pricing info
   */
  private extractPricing(model: any): {
    inputPrice?: number
    outputPrice?: number
  } {
    const p = model.pricing
    const ps = model.pricings

    if (ps) {
      // Zenmux-style: pricings.prompt / pricings.completion are arrays
      // Take the first entry as the base price
      const inputVal = Array.isArray(ps.prompt)
        ? ps.prompt[0]?.value
        : undefined
      const outputVal = Array.isArray(ps.completion)
        ? ps.completion[0]?.value
        : undefined
      return {
        inputPrice: inputVal != null ? Number(inputVal) : undefined,
        outputPrice: outputVal != null ? Number(outputVal) : undefined,
      }
    }

    if (p) {
      // OpenRouter-style: pricing.prompt / pricing.completion are per-token strings
      const rawInput = p.prompt ?? p.input
      const rawOutput = p.completion ?? p.output
      return {
        inputPrice: rawInput != null ? Number(rawInput) * 1_000_000 : undefined,
        outputPrice:
          rawOutput != null ? Number(rawOutput) * 1_000_000 : undefined,
      }
    }

    return {}
  }

  async *streamChatCompletion(
    messages: ChatMessage[],
    options: ChatCompletionOptions,
    features?: ChatCompletionFeatures
  ): AsyncGenerator<StreamChatDelta, void, unknown> {
    const opts = this.normalizeOptions(options, features)

    const body: Record<string, any> = {
      model: opts.model,
      messages: prepareOpenAIMessages(messages, opts.model),
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0.8,
      top_p: opts.topP ?? 0.8,
      stream: true,
      stream_options: { include_usage: true },
    }

    if (opts.tools?.length) {
      body.tools = opts.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
      if (opts.toolChoice && opts.toolChoice !== 'auto') {
        body.tool_choice = opts.toolChoice
      }
    }

    if (features?.enableThinking) {
      body.enable_thinking = true
      body.thinking_budget = features.thinkingBudget ?? opts.maxTokens ?? 1024
    }

    if (features?.enableSearch) {
      body.enable_search = true
      body.web_search_options = {
        search_context_size: 'medium',
        user_location: {
          type: 'approximate',
          approximate: { country: 'CN', timezone: 'Asia/Shanghai' },
        },
      }
    }

    const stream = await this.client.chat.completions.create(
      body as OpenAI.ChatCompletionCreateParams & { stream: true },
      { timeout: 90 * 1000, signal: features?.signal }
    )

    const aggregator = new OpenAIStreamAggregator()
    let finishReason: string | undefined

    for await (const chunk of stream) {
      if (chunk.usage) {
        const u = chunk.usage as any
        const cached = u.prompt_tokens_details?.cached_tokens
        const reasoning = u.completion_tokens_details?.reasoning_tokens
        yield {
          kind: 'usage',
          usage: {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
            cachedTokens: typeof cached === 'number' ? cached : undefined,
            reasoningTokens:
              typeof reasoning === 'number' ? reasoning : undefined,
          },
        }
      }

      const choice = (chunk as any).choices?.[0]
      const delta = choice?.delta
      if (!delta) {
        if (choice?.finish_reason) finishReason = choice.finish_reason
        continue
      }

      // 不要 trim — chunk 边界的空格会被吃掉，拼起来就丢空格。
      // 用 typeof 显式判断，避免 ''.trim() truthy 检查的副作用。
      const reasoning = delta.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        yield { kind: 'reasoning_content', content: reasoning }
      }

      const content = delta.content
      if (typeof content === 'string' && content.length > 0) {
        yield { kind: 'content', content }
      }

      if (delta.tool_calls) aggregator.absorbToolCallDeltas(delta.tool_calls)

      if (choice.finish_reason) finishReason = choice.finish_reason
    }

    // 流结束后输出聚合的 tool_calls
    try {
      for (const tc of aggregator.finalizeToolCalls()) {
        yield { kind: 'tool_call', toolCall: tc }
      }
    } catch (e: any) {
      yield { kind: 'error', error: e instanceof Error ? e : new Error(String(e)) }
    }

    yield {
      kind: 'finish',
      reason: mapOpenAIFinishReason(finishReason),
    }
  }
}
