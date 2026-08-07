import { describe, it, expect, vi } from 'vitest'
import {
  buildQuotedMessageBlock,
  extractQuoteMeta,
  resolveQuoteSeq,
} from '../utils/quoted-message'

const MAX = 1000

describe('buildQuotedMessageBlock', () => {
  it('wraps the quoted content with its author', () => {
    const block = buildQuotedMessageBlock(
      { content: '你好', author: '小鱼君', authorId: '12345' },
      MAX
    )
    expect(block).toBe(
      '<quoted_message author="小鱼君" author_id="12345">\n你好\n</quoted_message>'
    )
  })

  it('marks a message SILI sent herself', () => {
    // Quoting the bot's own words is the common case; without this the agent
    // cannot tell whether the user is replying to her or to someone else.
    const block = buildQuotedMessageBlock(
      { content: '好的', author: 'SILI', authorId: '233', self: true },
      MAX
    )
    expect(block).toContain('self="true"')
  })

  it('omits self when the quoted message is not the bot', () => {
    const block = buildQuotedMessageBlock({ content: 'x', author: 'a' }, MAX)
    expect(block).not.toContain('self=')
  })

  it('carries the history cursor when one is known', () => {
    // Lets the agent call read_channel_history around an old message instead of
    // paging back from the newest one.
    const block = buildQuotedMessageBlock({ content: 'x', seq: 4287 }, MAX)
    expect(block).toContain('seq="4287"')
  })

  it('omits attributes that are unknown', () => {
    const block = buildQuotedMessageBlock({ content: 'x' }, MAX)
    expect(block).toBe('<quoted_message>\nx\n</quoted_message>')
  })

  it('keeps element tags intact so images read like channel history does', () => {
    // read_channel_history renders images the same way; both must agree or the
    // agent sees two dialects of the same thing.
    const content = '看这个<img src="https://example.com/a.png"/>'
    const block = buildQuotedMessageBlock({ content }, MAX)
    expect(block).toContain('<img src="https://example.com/a.png"/>')
  })

  it('escapes quotes in attribute values', () => {
    const block = buildQuotedMessageBlock({ content: 'x', author: 'a"b' }, MAX)
    expect(block).toContain('author="a&quot;b"')
  })

  it('truncates an overlong quote with an ellipsis', () => {
    const block = buildQuotedMessageBlock({ content: 'a'.repeat(50) }, 10)
    expect(block).toBe(`<quoted_message>\n${'a'.repeat(10)}…\n</quoted_message>`)
  })

  it('leaves content alone when it fits', () => {
    const block = buildQuotedMessageBlock({ content: 'short' }, 10)
    expect(block).toContain('\nshort\n')
    expect(block).not.toContain('…')
  })

  it('treats a max length of 0 as no limit', () => {
    const long = 'a'.repeat(5000)
    expect(buildQuotedMessageBlock({ content: long }, 0)).toContain(long)
  })

  it('produces nothing for an empty or whitespace-only quote', () => {
    // A quote carrying only an image strips to '' here — but that case keeps the
    // <img> tag, so only a genuinely empty body yields no block.
    expect(buildQuotedMessageBlock({ content: '' }, MAX)).toBe('')
    expect(buildQuotedMessageBlock({ content: '   \n ' }, MAX)).toBe('')
  })

  it('orders attributes deterministically for prompt-cache stability', () => {
    // The block is persisted into openai_chat and replayed next turn; byte drift
    // would cost the provider's prefix cache.
    const meta = { content: 'x', author: 'a', authorId: '1', self: true, seq: 7 }
    expect(buildQuotedMessageBlock(meta, MAX)).toBe(
      '<quoted_message author="a" author_id="1" self="true" seq="7">\nx\n</quoted_message>'
    )
  })
})

describe('extractQuoteMeta', () => {
  it('returns nothing when the turn has no quote', () => {
    expect(extractQuoteMeta({ selfId: '233' })).toBeUndefined()
  })

  it('reads content, author and id off the quoted message', () => {
    const session = {
      selfId: '233',
      quote: { content: '你好', user: { id: '12345', name: '小鱼君' } },
    }
    expect(extractQuoteMeta(session)).toEqual({
      content: '你好',
      author: '小鱼君',
      authorId: '12345',
      self: false,
    })
  })

  it('prefers the guild nickname over the global name', () => {
    const session = {
      selfId: '233',
      quote: {
        content: 'x',
        user: { id: '1', name: '全局名' },
        member: { nick: '群昵称' },
      },
    }
    expect(extractQuoteMeta(session)?.author).toBe('群昵称')
  })

  it('flags a quote of the bot herself', () => {
    const session = {
      selfId: '233',
      quote: { content: 'x', user: { id: '233', name: 'SILI' } },
    }
    expect(extractQuoteMeta(session)?.self).toBe(true)
  })

  it('survives a quote with no user attached', () => {
    expect(extractQuoteMeta({ selfId: '233', quote: { content: 'x' } })).toEqual({
      content: 'x',
      author: undefined,
      authorId: undefined,
      self: false,
    })
  })
})

describe('resolveQuoteSeq', () => {
  it('reads message_seq via the OneBot get_msg call', async () => {
    // satori's Message has no seq field, so the adapter drops it — koishi's own
    // getMessageList re-fetches the same way to page history.
    const bot = { internal: { getMsg: vi.fn(async () => ({ message_seq: 4287 })) } }
    expect(await resolveQuoteSeq(bot, 'msg-1')).toBe(4287)
    expect(bot.internal.getMsg).toHaveBeenCalledWith('msg-1')
  })

  it('returns undefined on a platform without get_msg', async () => {
    expect(await resolveQuoteSeq({}, 'msg-1')).toBeUndefined()
  })

  it('returns undefined when the response carries no seq', async () => {
    const bot = { internal: { getMsg: async () => ({}) } }
    expect(await resolveQuoteSeq(bot, 'msg-1')).toBeUndefined()
  })

  it('swallows an API failure — a missing cursor must not cost us the quote', async () => {
    const bot = { internal: { getMsg: async () => { throw new Error('offline') } } }
    expect(await resolveQuoteSeq(bot, 'msg-1')).toBeUndefined()
  })

  it('returns undefined without an id to look up', async () => {
    const bot = { internal: { getMsg: vi.fn() } }
    expect(await resolveQuoteSeq(bot, undefined)).toBeUndefined()
    expect(bot.internal.getMsg).not.toHaveBeenCalled()
  })
})
