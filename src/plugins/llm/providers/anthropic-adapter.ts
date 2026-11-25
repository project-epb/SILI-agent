import type Anthropic from '@anthropic-ai/sdk'
import type { ChatMessage, StreamChatDelta } from './_base'
import type { ResolvedPart } from './images'

export function splitSystemMessages(messages: ChatMessage[]): {
  system: string
  rest: ChatMessage[]
} {
  const system = messages
    .filter((m): m is ChatMessage & { role: 'system' } => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const rest = messages.filter((m) => m.role !== 'system')
  return { system, rest }
}

function toAnthropicBlocks(parts: ResolvedPart[]): Anthropic.ContentBlockParam[] {
  return parts.map((p) =>
    p.type === 'text'
      ? { type: 'text', text: p.text }
      : {
          type: 'image',
          source: {
            type: 'base64',
            media_type: p.mime as Anthropic.Base64ImageSource['media_type'],
            data: Buffer.from(p.bytes).toString('base64'),
          },
        }
  )
}

/**
 * `resolved` holds the loaded parts of user messages that carry images. A
 * user message right after tool results joins their message: Anthropic
 * wants the turn after tool_use to be one user message.
 */
export function toAnthropicMessages(
  messages: ChatMessage[],
  resolved: Map<ChatMessage, ResolvedPart[]> = new Map()
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = []
  let pendingToolResults: Anthropic.ToolResultBlockParam[] = []

  const flush = () => {
    if (pendingToolResults.length) {
      out.push({ role: 'user', content: pendingToolResults })
      pendingToolResults = []
    }
  }

  for (const m of messages) {
    if (m.role === 'system') continue

    if (m.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: m.content,
      })
      continue
    }

    const parts = m.role === 'user' ? resolved.get(m) : undefined
    if (parts) {
      out.push({ role: 'user', content: [...pendingToolResults, ...toAnthropicBlocks(parts)] })
      pendingToolResults = []
      continue
    }

    flush()

    if (m.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const tc of m.tool_calls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        })
      }
      out.push({ role: 'assistant', content: blocks })
    } else {
      out.push({ role: 'user', content: m.content })
    }
  }

  flush()
  return out
}

interface AnthropicBlockState {
  type: 'text' | 'tool_use' | string
  id?: string
  name?: string
  argText: string
}

export class AnthropicStreamAggregator {
  private blocks = new Map<number, AnthropicBlockState>()

  startBlock(
    index: number,
    block: { type: string; id?: string; name?: string }
  ): void {
    this.blocks.set(index, {
      type: block.type,
      id: block.id,
      name: block.name,
      argText: '',
    })
  }

  appendInputJson(index: number, partial: string): void {
    const state = this.blocks.get(index)
    if (state) state.argText += partial
  }

  finalizeBlock(
    index: number
  ): Extract<StreamChatDelta, { kind: 'tool_call' }> | null {
    const state = this.blocks.get(index)
    if (!state) return null
    if (state.type !== 'tool_use') return null
    let args: Record<string, any>
    try {
      args = state.argText ? JSON.parse(state.argText) : {}
    } catch (e) {
      throw new Error(
        `Tool call JSON parse failed for ${state.name}: ${state.argText}`
      )
    }
    return {
      kind: 'tool_call',
      toolCall: { id: state.id!, name: state.name!, arguments: args },
    }
  }
}
