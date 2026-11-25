import { ClientOptions, OpenAI } from 'openai'

import {
  ChatCompletionFeatures,
  ChatCompletionOptions,
  ChatMessage,
  LLMProviderBase,
  StreamChatDelta,
  StreamFinishReason,
} from './_base'
import { IMAGE_EXPIRED_NOTE, IMAGE_UNSEEN_NOTE, dataUrl, splitImages } from './images'
import type { ProviderFiles } from '../services/provider-files'

type InputItem = Record<string, any>

/**
 * OpenAI Responses protocol. Unlike Chat Completions it lets an image be a
 * Files API `file_id`, so a picture replayed every turn is uploaded once.
 */
export class ResponsesProvider extends LLMProviderBase {
  readonly client: OpenAI
  /** Set when the provider's Files API is used for images (nativeFiles). */
  files?: ProviderFiles

  constructor(options: ClientOptions) {
    super()
    this.client = new OpenAI(options)
  }

  private async imagePart(id: string): Promise<InputItem> {
    if (!this.vision) return { type: 'input_text', text: IMAGE_UNSEEN_NOTE }
    const img = await this.imageSource?.read(id)
    if (this.files) {
      const fileId = await this.files.fileIdFor(id, img?.bytes, img?.type ?? 'image/webp')
      if (fileId) return { type: 'input_image', file_id: fileId, detail: 'auto' }
    } else if (img) {
      return { type: 'input_image', image_url: dataUrl(img.bytes, img.type), detail: 'auto' }
    }
    return { type: 'input_text', text: IMAGE_EXPIRED_NOTE }
  }

  /**
   * History as Responses input items. Thinking models need each tool call's
   * reasoning replayed as a `reasoning` item before its `function_call`s
   * (DeepSeek answers 400 without it).
   */
  async toInput(messages: ChatMessage[]): Promise<InputItem[]> {
    const input: InputItem[] = []
    for (const m of messages) {
      switch (m.role) {
        case 'system':
          input.push({ role: 'system', content: m.content })
          break
        case 'user': {
          if (!m.images?.length) {
            input.push({ role: 'user', content: m.content })
            break
          }
          const parts: InputItem[] = []
          for (const p of splitImages(m.content, m.images)) {
            const item = p.type === 'text' ? { type: 'input_text', text: p.text } : await this.imagePart(p.id)
            const last = parts[parts.length - 1]
            if (item.type === 'input_text' && last?.type === 'input_text') last.text += item.text
            else parts.push(item)
          }
          input.push({ role: 'user', content: parts })
          break
        }
        case 'assistant':
          if (m.reasoning_content && m.tool_calls?.length)
            input.push({
              type: 'reasoning',
              summary: [],
              content: [{ type: 'reasoning_text', text: m.reasoning_content }],
            })
          if (m.content) input.push({ role: 'assistant', content: m.content })
          for (const tc of m.tool_calls ?? [])
            input.push({
              type: 'function_call',
              call_id: tc.id,
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            })
          break
        case 'tool':
          input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content })
          break
      }
    }
    return input
  }

  async *streamChatCompletion(
    messages: ChatMessage[],
    options: ChatCompletionOptions,
    features?: ChatCompletionFeatures
  ): AsyncGenerator<StreamChatDelta, void, unknown> {
    const body: Record<string, any> = {
      model: options.model,
      input: await this.toInput(messages),
      max_output_tokens: options.maxTokens ?? 1024,
      temperature: options.temperature ?? 0.8,
      top_p: options.topP ?? 0.8,
      stream: true,
    }
    if (options.tools?.length) {
      body.tools = options.tools.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        strict: false,
      }))
      if (options.toolChoice && options.toolChoice !== 'auto') body.tool_choice = options.toolChoice
    }
    if (features?.enableThinking) body.reasoning = { effort: 'high' }

    const stream: AsyncIterable<any> = (await this.client.responses.create(body as any, {
      timeout: 90 * 1000,
      signal: features?.signal,
    })) as any

    let reason: StreamFinishReason = 'other'
    let sawToolCall = false
    for await (const ev of stream) {
      switch (ev.type) {
        case 'response.reasoning_text.delta':
          if (ev.delta) yield { kind: 'reasoning_content', content: ev.delta }
          break
        case 'response.output_text.delta':
          if (ev.delta) yield { kind: 'content', content: ev.delta }
          break
        case 'response.output_item.done':
          if (ev.item?.type === 'function_call') {
            sawToolCall = true
            try {
              yield {
                kind: 'tool_call',
                toolCall: {
                  id: ev.item.call_id,
                  name: ev.item.name,
                  arguments: ev.item.arguments ? JSON.parse(ev.item.arguments) : {},
                },
              }
            } catch {
              yield {
                kind: 'error',
                error: new Error(`Tool call JSON parse failed for ${ev.item.name}: ${ev.item.arguments}`),
              }
            }
          }
          break
        case 'response.completed':
        case 'response.incomplete': {
          const r = ev.response
          const u = r?.usage
          if (u)
            yield {
              kind: 'usage',
              usage: {
                promptTokens: u.input_tokens,
                completionTokens: u.output_tokens,
                totalTokens: u.total_tokens,
                cachedTokens: u.input_tokens_details?.cached_tokens,
                reasoningTokens: u.output_tokens_details?.reasoning_tokens,
              },
            }
          reason =
            r?.incomplete_details?.reason === 'max_output_tokens'
              ? 'length'
              : sawToolCall
                ? 'tool_calls'
                : r?.status === 'completed'
                  ? 'stop'
                  : 'other'
          break
        }
        case 'response.failed':
        case 'error':
          yield {
            kind: 'error',
            error: new Error(ev.response?.error?.message ?? ev.message ?? JSON.stringify(ev).slice(0, 500)),
          }
          break
      }
    }
    yield { kind: 'finish', reason }
  }
}
