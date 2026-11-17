import { describe, expect, it, vi } from 'vitest'

import type {
  ChatMessage,
  LLMProviderBase,
  StreamChatDelta,
} from '../providers/_base'
import { SummaryCompactor } from '../services/summary-compactor'

/** Build the minimal mocked surface SummaryCompactor depends on. */
function mkDeps(over: {
  promptTokens?: number
  history?: ChatMessage[]
  summary?: string | Error
  memory?: { content?: string; last_updated_at?: number } | null | Error
}) {
  const createCalls: any[] = []
  const sessionsCreated: any[] = []
  const ctx = {
    database: {
      create: vi.fn(async (table: string, row: any) => {
        createCalls.push({ table, row })
        return row
      }),
    },
  } as any
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    success: vi.fn(),
  } as any
  const history = {
    latestPromptTokens: vi.fn(async () => over.promptTokens ?? 0),
    getById: vi.fn(async () => over.history ?? []),
  } as any
  const sessions = {
    create: vi.fn(async (input: any) => {
      sessionsCreated.push(input)
      return { id: 1, ...input }
    }),
  } as any
  const turns = {
    allocate: vi.fn(async () => 1),
  } as any
  const memory = {
    getMeta: vi.fn(async () => {
      if (over.memory instanceof Error) throw over.memory
      if (over.memory === null) return null
      return over.memory ?? null
    }),
  } as any

  const provider: LLMProviderBase = {
    async *streamChatCompletion(): AsyncGenerator<StreamChatDelta> {
      if (over.summary instanceof Error) {
        yield { kind: 'error', error: over.summary }
        return
      }
      if (typeof over.summary === 'string') {
        yield { kind: 'content', content: over.summary }
      }
      yield { kind: 'finish', reason: 'stop' }
    },
  } as any

  return { ctx, logger, history, sessions, turns, memory, provider, createCalls, sessionsCreated }
}

const INPUT = {
  conversation_id: 'old-conv',
  conversation_owner: 42,
  systemPrompt: 'sys',
  model: 'gpt-test',
  platform: 'qq',
  userId: '999',
}

describe('SummaryCompactor', () => {
  it('returns ran=false when maxContextTokens is 0 (disabled)', async () => {
    const d = mkDeps({ promptTokens: 100 })
    const c = new SummaryCompactor(
      d.ctx,
      d.logger,
      d.history,
      d.sessions,
      d.turns,
      d.memory,
      { maxContextTokens: 0 }
    )
    const r = await c.compactIfNeeded({ ...INPUT, provider: d.provider })
    expect(r.ran).toBe(false)
    expect(r.reason).toBe('disabled')
    expect(d.history.latestPromptTokens).not.toHaveBeenCalled()
  })

  it('returns ran=false when the context is under the threshold', async () => {
    const d = mkDeps({ promptTokens: 5 })
    const c = new SummaryCompactor(
      d.ctx,
      d.logger,
      d.history,
      d.sessions,
      d.turns,
      d.memory,
      { maxContextTokens: 10 }
    )
    const r = await c.compactIfNeeded({ ...INPUT, provider: d.provider })
    expect(r.ran).toBe(false)
    expect(r.reason).toContain('under threshold')
    expect(d.history.getById).not.toHaveBeenCalled()
  })

  it('returns ran=false when history is empty (nothing to summarize)', async () => {
    const d = mkDeps({ promptTokens: 50, history: [] })
    const c = new SummaryCompactor(
      d.ctx,
      d.logger,
      d.history,
      d.sessions,
      d.turns,
      d.memory,
      { maxContextTokens: 10 }
    )
    const r = await c.compactIfNeeded({ ...INPUT, provider: d.provider })
    expect(r.ran).toBe(false)
    expect(r.reason).toContain('no history')
  })

  it('returns ran=false when summary call yields empty text', async () => {
    const d = mkDeps({
      promptTokens: 50,
      history: [{ role: 'user', content: 'hi' }],
      summary: '   ',
    })
    const c = new SummaryCompactor(
      d.ctx,
      d.logger,
      d.history,
      d.sessions,
      d.turns,
      d.memory,
      { maxContextTokens: 10 }
    )
    const r = await c.compactIfNeeded({ ...INPUT, provider: d.provider })
    expect(r.ran).toBe(false)
    expect(r.reason).toBe('empty summary')
    expect(d.createCalls).toHaveLength(0)
  })

  it('returns ran=false when summary call errors', async () => {
    const d = mkDeps({
      promptTokens: 50,
      history: [{ role: 'user', content: 'hi' }],
      summary: new Error('boom'),
    })
    const c = new SummaryCompactor(
      d.ctx,
      d.logger,
      d.history,
      d.sessions,
      d.turns,
      d.memory,
      { maxContextTokens: 10 }
    )
    const r = await c.compactIfNeeded({ ...INPUT, provider: d.provider })
    expect(r.ran).toBe(false)
    expect(r.reason).toContain('boom')
    expect(d.logger.warn).toHaveBeenCalled()
  })

  it('happy path: persists summary pair + new session, returns new id', async () => {
    const d = mkDeps({
      promptTokens: 50,
      history: [
        { role: 'user', content: 'turn1' },
        { role: 'assistant', content: 'reply1' },
      ],
      summary: '我（SILI）和这位用户聊了 X 和 Y',
    })
    const c = new SummaryCompactor(
      d.ctx,
      d.logger,
      d.history,
      d.sessions,
      d.turns,
      d.memory,
      { maxContextTokens: 10 }
    )
    const r = await c.compactIfNeeded({ ...INPUT, provider: d.provider })

    expect(r.ran).toBe(true)
    expect(r.newConversationId).toBeTypeOf('string')
    expect(r.newConversationId).not.toBe('old-conv')
    expect(r.prevConversationId).toBe('old-conv')
    expect(r.summaryLength).toBeGreaterThan(0)

    // Two openai_chat rows: synthetic user prompt + assistant summary
    const chatRows = d.createCalls.filter((c) => c.table === 'openai_chat')
    expect(chatRows).toHaveLength(2)
    expect(chatRows[0].row).toMatchObject({
      role: 'user',
      conversation_id: r.newConversationId,
      turn_number: 1,
      intra_turn_seq: 0,
    })
    expect(chatRows[1].row).toMatchObject({
      role: 'assistant',
      conversation_id: r.newConversationId,
      turn_number: 1,
      intra_turn_seq: 1,
      content: '我（SILI）和这位用户聊了 X 和 Y',
      model: 'gpt-test',
    })

    // New session row links back via prev_session_id
    expect(d.sessionsCreated).toHaveLength(1)
    expect(d.sessionsCreated[0]).toMatchObject({
      conversationId: r.newConversationId,
      conversationOwner: 42,
      platform: 'qq',
      userId: '999',
      prevSessionId: 'old-conv',
    })
  })

  it('passes the summary call through provider with tools disabled', async () => {
    let receivedOptions: any
    const d = mkDeps({
      promptTokens: 50,
      history: [{ role: 'user', content: 'hi' }],
    })
    d.provider.streamChatCompletion = (async function* (
      _msgs: any,
      opts: any
    ): AsyncGenerator<StreamChatDelta> {
      receivedOptions = opts
      yield { kind: 'content', content: 'summary' }
      yield { kind: 'finish', reason: 'stop' }
    }) as any

    const c = new SummaryCompactor(
      d.ctx,
      d.logger,
      d.history,
      d.sessions,
      d.turns,
      d.memory,
      { maxContextTokens: 10, maxTokens: 999 }
    )
    await c.compactIfNeeded({ ...INPUT, provider: d.provider })

    expect(receivedOptions.tools).toEqual([])
    expect(receivedOptions.maxTokens).toBe(999)
    expect(receivedOptions.model).toBe('gpt-test')
    expect(receivedOptions.temperature).toBeLessThan(0.5)
  })

  it('prepends a <long_term_memory> snapshot when the user has memory', async () => {
    let receivedMessages: ChatMessage[] = []
    const d = mkDeps({
      promptTokens: 50,
      history: [{ role: 'user', content: 'hi' }],
      summary: 'compacted',
      memory: { content: '- 喜欢吃热干面\n- 在杭州' },
    })
    d.provider.streamChatCompletion = (async function* (
      msgs: ChatMessage[]
    ): AsyncGenerator<StreamChatDelta> {
      receivedMessages = msgs
      yield { kind: 'content', content: 'compacted' }
      yield { kind: 'finish', reason: 'stop' }
    }) as any

    const c = new SummaryCompactor(
      d.ctx,
      d.logger,
      d.history,
      d.sessions,
      d.turns,
      d.memory,
      { maxContextTokens: 10 }
    )
    const r = await c.compactIfNeeded({ ...INPUT, provider: d.provider })

    expect(r.ran).toBe(true)
    expect(d.memory.getMeta).toHaveBeenCalledWith('qq', '999')
    const lastUserMessage = receivedMessages[receivedMessages.length - 1]
    expect(lastUserMessage.role).toBe('user')
    expect((lastUserMessage as { content: string }).content).toMatch(
      /<long_term_memory>[\s\S]*喜欢吃热干面[\s\S]*在杭州[\s\S]*<\/long_term_memory>/
    )
    // Memory should be persisted into the new conversation's seed user row
    const chatRows = d.createCalls.filter((c) => c.table === 'openai_chat')
    expect(chatRows[0].row.content).toContain('<long_term_memory>')
    expect(chatRows[0].row.content).toContain('喜欢吃热干面')
  })

  it('never seeds a group conversation with a member\'s memory', async () => {
    let receivedMessages: ChatMessage[] = []
    const d = mkDeps({
      promptTokens: 50,
      history: [{ role: 'user', content: 'hi' }],
      summary: 'compacted',
      memory: { content: '- 喜欢吃热干面' },
    })
    d.provider.streamChatCompletion = (async function* (
      msgs: ChatMessage[]
    ): AsyncGenerator<StreamChatDelta> {
      receivedMessages = msgs
      yield { kind: 'content', content: 'compacted' }
      yield { kind: 'finish', reason: 'stop' }
    }) as any

    const c = new SummaryCompactor(
      d.ctx,
      d.logger,
      d.history,
      d.sessions,
      d.turns,
      d.memory,
      { maxContextTokens: 10 }
    )
    const r = await c.compactIfNeeded({
      ...INPUT,
      provider: d.provider,
      includeMemory: false,
    })

    expect(r.ran).toBe(true)
    const lastUserMessage = receivedMessages[receivedMessages.length - 1]
    expect((lastUserMessage as { content: string }).content).not.toContain('喜欢吃热干面')
    const chatRows = d.createCalls.filter((c) => c.table === 'openai_chat')
    expect(chatRows[0].row.content).not.toContain('<long_term_memory>')
  })

  it('skips the memory block when user has no memory', async () => {
    let receivedMessages: ChatMessage[] = []
    const d = mkDeps({
      promptTokens: 50,
      history: [{ role: 'user', content: 'hi' }],
      summary: 'compacted',
      memory: null,
    })
    d.provider.streamChatCompletion = (async function* (
      msgs: ChatMessage[]
    ): AsyncGenerator<StreamChatDelta> {
      receivedMessages = msgs
      yield { kind: 'content', content: 'compacted' }
      yield { kind: 'finish', reason: 'stop' }
    }) as any

    const c = new SummaryCompactor(
      d.ctx,
      d.logger,
      d.history,
      d.sessions,
      d.turns,
      d.memory,
      { maxContextTokens: 10 }
    )
    await c.compactIfNeeded({ ...INPUT, provider: d.provider })

    const lastUserMessage = receivedMessages[receivedMessages.length - 1]
    expect((lastUserMessage as { content: string }).content).not.toContain(
      '<long_term_memory>'
    )
  })

  it('proceeds normally when memory fetch errors', async () => {
    const d = mkDeps({
      promptTokens: 50,
      history: [{ role: 'user', content: 'hi' }],
      summary: 'compacted',
      memory: new Error('memory db unavailable'),
    })

    const c = new SummaryCompactor(
      d.ctx,
      d.logger,
      d.history,
      d.sessions,
      d.turns,
      d.memory,
      { maxContextTokens: 10 }
    )
    const r = await c.compactIfNeeded({ ...INPUT, provider: d.provider })

    expect(r.ran).toBe(true)
    expect(d.logger.warn).toHaveBeenCalled()
  })
})
