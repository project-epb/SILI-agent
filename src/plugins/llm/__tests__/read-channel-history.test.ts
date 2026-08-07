import { describe, expect, it } from 'vitest'

import {
  renderSegment,
  renderHistoryPayload,
  resolveHistoryAnchor,
  trimAlreadySeen,
  type OneBotHistoryMessage,
} from '../tools/read-channel-history'

describe('renderSegment', () => {
  it('renders text with XML escaping', () => {
    expect(renderSegment({ type: 'text', data: { text: 'hello' } })).toBe(
      'hello'
    )
    expect(
      renderSegment({ type: 'text', data: { text: 'a < b && c > d' } })
    ).toBe('a &lt; b &amp;&amp; c &gt; d')
  })

  it('renders image with src attribute', () => {
    expect(
      renderSegment({
        type: 'image',
        data: { url: 'https://qq.com/x.jpg', summary: '[图片]' },
      })
    ).toBe('<img src="https://qq.com/x.jpg" summary="[图片]"/>')
  })

  it('renders at with id and special "all" form', () => {
    expect(renderSegment({ type: 'at', data: { qq: '123' } })).toBe(
      '<at id="123"/>'
    )
    expect(renderSegment({ type: 'at', data: { qq: 'all' } })).toBe(
      '<at type="all"/>'
    )
  })

  it('renders reply as <quote>', () => {
    expect(renderSegment({ type: 'reply', data: { id: 99 } })).toBe(
      '<quote id="99"/>'
    )
  })

  it('renders face / mface / record / video / file', () => {
    expect(renderSegment({ type: 'face', data: { id: 1 } })).toBe(
      '<face id="1"/>'
    )
    expect(
      renderSegment({ type: 'video', data: { url: 'https://v.qq.com/a' } })
    ).toBe('<video src="https://v.qq.com/a"/>')
    expect(
      renderSegment({ type: 'record', data: { url: 'https://r.qq.com/a' } })
    ).toBe('<audio src="https://r.qq.com/a"/>')
    expect(
      renderSegment({
        type: 'file',
        data: { url: 'https://f.qq.com/a', file_name: 'doc.pdf' },
      })
    ).toBe('<file src="https://f.qq.com/a" name="doc.pdf"/>')
  })

  it('escapes attribute values', () => {
    expect(
      renderSegment({ type: 'image', data: { url: 'a"b&c<d' } })
    ).toBe('<img src="a&quot;b&amp;c&lt;d"/>')
  })

  it('falls back to empty tag for unknown types', () => {
    expect(renderSegment({ type: 'weird_card' })).toBe('<weird_card/>')
  })

  it('handles malformed input gracefully', () => {
    expect(renderSegment(null as any)).toBe('')
    expect(renderSegment(undefined as any)).toBe('')
    expect(renderSegment({} as any)).toBe('')
  })
})

describe('renderHistoryPayload', () => {
  const baseMsg = (over: Partial<OneBotHistoryMessage>): OneBotHistoryMessage => ({
    message_id: 1,
    message_seq: 1,
    time: 1779024000,
    sender: { user_id: 100, nickname: 'alice', card: '', role: 'member' },
    message: [{ type: 'text', data: { text: 'hi' } }],
    group_id: 999,
    group_name: 'test-room',
    ...over,
  })

  it('produces header + lines + footer for a normal batch', () => {
    const msgs = [
      baseMsg({ message_seq: 100, time: 1779024000 }),
      baseMsg({
        message_seq: 101,
        time: 1779024060,
        sender: { user_id: 200, nickname: 'bob', card: 'Bobby', role: 'owner' },
        message: [{ type: 'text', data: { text: 'hello back' } }],
      }),
    ]
    const out = renderHistoryPayload(msgs, {
      channelId: '999',
      countRequested: 20,
    })
    expect(out).toContain('Channel: 999 (test-room)')
    expect(out).toContain(
      'Messages (oldest → newest, 2 of 20 requested):'
    )
    expect(out).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] alice \(100\): hi/)
    expect(out).toMatch(/Bobby \(200, owner\): hello back/)
    expect(out).toContain('before_seq=100')
  })

  it('tags bot self messages via post_type=message_sent', () => {
    const msgs = [
      baseMsg({
        post_type: 'message_sent',
        message_sent_type: 'self',
        self_id: 100,
      }),
    ]
    const out = renderHistoryPayload(msgs, {
      channelId: '999',
      countRequested: 5,
    })
    expect(out).toMatch(/alice \(100, self\):/)
  })

  it('tags self via self_id match even without post_type', () => {
    const msgs = [
      baseMsg({
        self_id: 100,
      }),
    ]
    const out = renderHistoryPayload(msgs, {
      channelId: '999',
      countRequested: 5,
    })
    expect(out).toMatch(/alice \(100, self\):/)
  })

  it('shows multiple tags joined by comma', () => {
    const msgs = [
      baseMsg({
        sender: { user_id: 100, nickname: 'alice', card: '', role: 'owner' },
        post_type: 'message_sent',
        self_id: 100,
      }),
    ]
    const out = renderHistoryPayload(msgs, {
      channelId: '999',
      countRequested: 5,
    })
    expect(out).toMatch(/alice \(100, owner,self\):/)
  })

  it('prefers group card over nickname', () => {
    const msgs = [
      baseMsg({
        sender: {
          user_id: 100,
          nickname: 'real-name',
          card: 'group-nickname',
          role: 'member',
        },
      }),
    ]
    const out = renderHistoryPayload(msgs, {
      channelId: '999',
      countRequested: 5,
    })
    expect(out).toContain('group-nickname (100)')
    expect(out).not.toContain('real-name')
  })

  it('falls back when sender is missing', () => {
    const msgs = [baseMsg({ sender: undefined })]
    const out = renderHistoryPayload(msgs, {
      channelId: '999',
      countRequested: 5,
    })
    expect(out).toContain('(unknown) (?)')
  })

  it('handles empty messages array (no footer, no time range)', () => {
    const out = renderHistoryPayload([], {
      channelId: '999',
      channelName: 'test-room',
      countRequested: 20,
    })
    expect(out).toContain('Channel: 999 (test-room)')
    expect(out).toContain('Messages (oldest → newest, 0 of 20 requested):')
    expect(out).not.toContain('before_seq=')
    expect(out).not.toContain('Time range:')
  })

  it('renders mixed segments in one message', () => {
    const msgs = [
      baseMsg({
        message: [
          { type: 'at', data: { qq: '100' } },
          { type: 'text', data: { text: ' 看这个 ' } },
          { type: 'image', data: { url: 'https://q.com/i.jpg' } },
          { type: 'text', data: { text: ' 怎么样' } },
        ],
      }),
    ]
    const out = renderHistoryPayload(msgs, {
      channelId: '999',
      countRequested: 5,
    })
    expect(out).toMatch(
      /alice \(100\): <at id="100"\/> 看这个 <img src="https:\/\/q\.com\/i\.jpg"\/> 怎么样/
    )
  })

  it('renders time range using Asia/Shanghai timezone', () => {
    // 1779024000 = 2026-05-17 13:20:00 UTC = 2026-05-17 21:20:00 +08:00
    const msgs = [
      baseMsg({ message_seq: 1, time: 1779024000 }),
      baseMsg({ message_seq: 2, time: 1779024600 }),
    ]
    const out = renderHistoryPayload(msgs, {
      channelId: '999',
      countRequested: 5,
    })
    expect(out).toMatch(/Time range: 2026-05-17 21:20:00 ~ 2026-05-17 21:30:00/)
  })

  it('shows already-seen hint in header when meta carries trim info', () => {
    const msgs = [baseMsg({ message_seq: 105, time: 1779024000 })]
    const out = renderHistoryPayload(msgs, {
      channelId: '999',
      countRequested: 20,
      alreadySeenCount: 7,
      previousMaxSeq: 104,
    })
    expect(out).toContain('已隐藏 7 条')
    expect(out).toContain('seq ≤ 104')
    expect(out).toContain('before_seq=105')
  })

  it('omits already-seen hint when trim count is 0', () => {
    const msgs = [baseMsg({})]
    const out = renderHistoryPayload(msgs, {
      channelId: '999',
      countRequested: 5,
      alreadySeenCount: 0,
      previousMaxSeq: 50,
    })
    expect(out).not.toContain('已隐藏')
  })
})

describe('trimAlreadySeen', () => {
  const mk = (seq: number): OneBotHistoryMessage => ({
    message_seq: seq,
    time: 1779024000 + seq,
    sender: { user_id: 1, nickname: 'a' },
    message: [{ type: 'text', data: { text: 'x' } }],
  })

  it('keeps only messages with seq > cachedMaxSeq', () => {
    const r = trimAlreadySeen([mk(1), mk(2), mk(3), mk(4)], 2)
    expect(r.kept.map((m) => m.message_seq)).toEqual([3, 4])
    expect(r.trimmedCount).toBe(2)
  })

  it('returns empty kept when cachedMaxSeq >= all seqs', () => {
    const r = trimAlreadySeen([mk(1), mk(2)], 5)
    expect(r.kept).toHaveLength(0)
    expect(r.trimmedCount).toBe(2)
  })

  it('returns everything when cachedMaxSeq < all seqs', () => {
    const r = trimAlreadySeen([mk(10), mk(11)], 5)
    expect(r.kept).toHaveLength(2)
    expect(r.trimmedCount).toBe(0)
  })

  it('drops messages with missing seq (treated as not-newer-than cache)', () => {
    const noSeq = { time: 1, sender: { user_id: 1 }, message: [] } as OneBotHistoryMessage
    const r = trimAlreadySeen([noSeq, mk(10)], 5)
    expect(r.kept.map((m) => m.message_seq)).toEqual([10])
    expect(r.trimmedCount).toBe(1)
  })

  it('returns input unchanged when cachedMaxSeq is non-finite', () => {
    const msgs = [mk(1), mk(2)]
    const r = trimAlreadySeen(msgs, NaN)
    expect(r.kept).toBe(msgs)
    expect(r.trimmedCount).toBe(0)
  })
})

describe('resolveHistoryAnchor', () => {
  const bot = (seq?: number, fail = false) => ({
    internal: {
      getMsg: async () => {
        if (fail) throw new Error('offline')
        return seq === undefined ? {} : { message_seq: seq }
      },
    },
  })

  it('prefers an explicit before_seq — it is already the native cursor', async () => {
    const r = await resolveHistoryAnchor(bot(999), {
      before_seq: 500,
      before_message_id: '123',
    })
    expect(r).toEqual({ seq: 500 })
  })

  it('uses the message_seq verbatim — the cursor already includes the anchor', async () => {
    // Verified against NapCat 4.18.4: with reverse_order, message_seq means "this
    // message and the `count` before it", so no offset. An offset would also be
    // meaningless — message_seq is not a dense counter, it equals message_id.
    const r = await resolveHistoryAnchor(bot(4287), { before_message_id: '123' })
    expect(r).toEqual({ seq: 4287 })
  })

  it('reports a message id it could not resolve instead of silently ignoring it', async () => {
    // Silently falling back to the latest window would answer a different
    // question than the agent asked.
    const r = await resolveHistoryAnchor(bot(undefined), { before_message_id: '123' })
    expect(r.seq).toBeUndefined()
    expect(r.error).toContain('123')
  })

  it('reports an API failure the same way', async () => {
    const r = await resolveHistoryAnchor(bot(1, true), { before_message_id: '123' })
    expect(r.seq).toBeUndefined()
    expect(r.error).toBeTruthy()
  })

  it('yields no anchor when neither argument is given', async () => {
    expect(await resolveHistoryAnchor(bot(1), {})).toEqual({ seq: undefined })
  })

  it('ignores a non-positive before_seq', async () => {
    expect(await resolveHistoryAnchor(bot(1), { before_seq: 0 })).toEqual({
      seq: undefined,
    })
  })
})
