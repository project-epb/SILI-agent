export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, any>
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, any>
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | {
      role: 'user'
      content: string
      /**
       * Images whose pixels go with this message, by id; each is sent right
       * after its `<image id=…/>` tag in `content` (see providers/images.ts).
       */
      images?: string[]
    }
  | {
      role: 'assistant'
      content: string
      tool_calls?: ToolCall[]
      reasoning_content?: string
    }
  | {
      role: 'tool'
      tool_call_id: string
      tool_name: string
      content: string
      /**
       * Images this result brings in. Never sent inside the tool result:
       * withToolAttachments moves them into a user message after the batch.
       */
      images?: string[]
    }

export interface ChatCompletionOptions {
  model: string
  maxTokens?: number
  temperature?: number
  topP?: number
  tools?: ToolDefinition[]
  toolChoice?: 'auto' | 'none' | 'required'
}

export interface ChatCompletionFeatures {
  enableThinking?: boolean
  thinkingBudget?: number
  enableSearch?: boolean
  /**
   * AbortSignal for cancelling an in-flight request. When the caller wants
   * to interrupt mid-stream (user typed a new message before the bot
   * finished), aborting via this signal terminates the underlying SDK
   * fetch — no more deltas arrive on the generator.
   */
  signal?: AbortSignal
}

export interface ChatCompletionUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  /**
   * Input tokens served from the provider's prompt cache (no full re-encoding
   * billed). OpenAI: `prompt_tokens_details.cached_tokens`. Anthropic:
   * `cache_read_input_tokens`. Already counted inside `promptTokens` — this
   * is a breakdown, not an additional total.
   */
  cachedTokens?: number
  /**
   * Tokens spent on the model's hidden reasoning / thinking. OpenAI o-series
   * + DeepSeek-R1: `completion_tokens_details.reasoning_tokens`. Already
   * counted inside `completionTokens`. Anthropic streams thinking text and
   * folds it into `output_tokens` without a separate count — left undefined
   * there.
   */
  reasoningTokens?: number
}

export type StreamFinishReason = 'stop' | 'tool_calls' | 'length' | 'other'

export type StreamChatDelta =
  | { kind: 'reasoning_content'; content: string }
  | { kind: 'content'; content: string }
  | { kind: 'tool_call'; toolCall: ToolCall }
  | { kind: 'usage'; usage: ChatCompletionUsage }
  | { kind: 'error'; error: Error }
  | { kind: 'finish'; reason: StreamFinishReason }

export interface ModelInfo {
  id: string
  name?: string
  ownedBy?: string
  contextLength?: number
  inputPrice?: number
  outputPrice?: number
}

/** Where providers read stored images from (the llm image store). */
export interface ImageSource {
  read(id: string): Promise<{ bytes: Uint8Array; type: string } | undefined>
}

export abstract class LLMProviderBase {
  /** Whether the model reads images; without it they become a note. */
  vision = false
  imageSource?: ImageSource

  protected normalizeOptions(
    options: ChatCompletionOptions,
    features?: ChatCompletionFeatures
  ): ChatCompletionOptions {
    return options
  }

  async listModels(): Promise<ModelInfo[]> {
    return []
  }

  abstract streamChatCompletion(
    messages: ChatMessage[],
    options: ChatCompletionOptions,
    features?: ChatCompletionFeatures
  ): AsyncGenerator<StreamChatDelta, void, unknown>
}
