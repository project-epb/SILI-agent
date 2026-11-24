import { describe, expect, it, vi } from 'vitest'

import MoegirlGroupUtils from '../MoegirlGroupUtils'

vi.mock('koishi', () => ({
  $: { sum: () => 1 },
  Time: { minute: 60_000, hour: 3_600_000, day: 86_400_000, format: String },
  h: {
    select: (elements, tag) => elements.filter((e) => e.type === tag),
    text: (text) => ({ type: 'text', attrs: { content: text } }),
  },
  snakeCase: (name) => name,
}))

const logGroup = '萌娘百科官方群组群管理沟通群'

function setup() {
  const handlers = new Map<string, (...args: any[]) => any>()
  const entries = []
  const logChannels = [
    { id: 'log-group', allowProactive: true, recvRejected: false },
  ]
  const mute = vi.fn().mockResolvedValue(undefined)
  const recall = vi.fn().mockResolvedValue(undefined)
  const send = vi.fn().mockResolvedValue(['sent'])
  const warn = vi.fn()
  const ctx = {
    before: (event, handler) => handlers.set(event, handler),
    on: (event, handler) => handlers.set(event, handler),
    model: { extend: vi.fn() },
    logger: () => ({ info: vi.fn(), warn }),
    database: {
      get: vi.fn(async (table, query) => {
        if (table === 'qqbot_migration') {
          return query.selfId === 'sili' ? [{ newId: 'group-openid' }] : []
        }
        if (table === 'qqbot_channel') return logChannels
        return entries.filter((row) =>
          Object.entries(query).every(([key, value]) => row[key] === value)
        )
      }),
      create: vi.fn(async (_, row) => {
        const entry = { ...row, id: entries.length + 1 }
        entries.push(entry)
        return entry
      }),
      select: vi.fn((_, query) => ({
        execute: async () =>
          entries.filter(
            (row) =>
              row.selfId === query.selfId &&
              row.userId === query.userId &&
              row.id <= (query.id?.$lte ?? Infinity)
          ).length,
      })),
    },
  }
  new MoegirlGroupUtils(ctx as any, {
    groupIds: ['legacy-group-number'],
    keywords: ['测试关键词'],
  })
  function session(messageId = 'm1', overrides = {}) {
    return {
      platform: 'qq',
      selfId: 'sili',
      channelId: 'group-openid',
      messageId,
      userId: 'member',
      username: '测试用户',
      event: { channel: { name: '测试来源群' } },
      elements: [{ type: 'text', attrs: { content: '含测试关键词的文本' } }],
      bot: {
        muteGuildMember: mute,
        deleteMessage: recall,
        sendMessage: send,
      },
      getUser: async () => ({ authority: 1 }),
      ...overrides,
    }
  }
  return {
    ctx,
    handlers,
    session,
    logChannels,
    entries,
    mute,
    recall,
    send,
    warn,
  }
}

describe('MoegirlGroupUtils on official QQ', () => {
  it('escalates a mapped group member to a 30-day mute and ignores repeated delivery', async () => {
    const { ctx, handlers, session, entries, mute, send } = setup()
    const onMessage = handlers.get('message')!
    for (const id of ['m1', 'm2', 'm3', 'm4', 'm4'])
      await onMessage(session(id))

    expect(entries).toHaveLength(4)
    expect(mute.mock.calls.map((call) => call[2])).toEqual([
      600_000, 7_200_000, 86_400_000, 2_592_000_000,
    ])
    expect(ctx.database.get).toHaveBeenCalledWith(
      'qqbot_migration',
      {
        kind: 'group',
        selfId: 'sili',
        oldId: ['legacy-group-number'],
      },
      ['newId']
    )
    expect(ctx.database.get).toHaveBeenCalledWith(
      'qqbot_channel',
      { selfId: 'sili', platform: 'qq', name: logGroup },
      expect.any(Array)
    )
    expect(send).toHaveBeenLastCalledWith('log-group', {
      type: 'text',
      attrs: { content: expect.stringContaining('第 4 次触发') },
    })
  })

  it('applies concurrent sanctions in increasing duration order', async () => {
    const { handlers, session, mute } = setup()
    let release: () => void
    mute.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const onMessage = handlers.get('message')!
    const first = onMessage(session('m1'))
    const second = onMessage(session('m2'))
    await vi.waitFor(() => expect(mute).toHaveBeenCalledTimes(1))
    release()
    await Promise.all([first, second])
    expect(mute.mock.calls.map((call) => call[2])).toEqual([600_000, 7_200_000])
  })

  it('leaves other groups, other bots and group administrators alone', async () => {
    const { handlers, session, entries, mute, send } = setup()
    const onMessage = handlers.get('message')!
    await onMessage(session('m1', { channelId: 'other-group' }))
    await onMessage(session('m2', { selfId: 'other-bot' }))
    await onMessage(
      session('m3', { event: { member: { roles: [{ id: 'admin' }] } } })
    )
    await onMessage(
      session('m4', { event: { _data: { d: { author: { bot: true } } } } })
    )
    expect(entries).toEqual([])
    expect(mute).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('warns without sending to a group that lacks proactive permission or is ambiguous', async () => {
    const { handlers, session, logChannels, send, warn, mute } = setup()
    const onMessage = handlers.get('message')!
    logChannels[0].allowProactive = false
    await onMessage(session('m1'))
    logChannels[0].allowProactive = true
    logChannels.push({
      id: 'another-group',
      allowProactive: true,
      recvRejected: false,
    })
    await onMessage(session('m2'))
    expect(mute).toHaveBeenCalledTimes(2)
    expect(send).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('reports failures with the audit and warns when the same account requests to join', async () => {
    const { handlers, session, mute, recall, send } = setup()
    mute.mockRejectedValueOnce(new Error('forbidden'))
    recall.mockRejectedValueOnce(new Error('forbidden'))
    await handlers.get('message')!(session())
    expect(send.mock.calls[0][1].attrs.content).toContain('禁言失败')
    expect(send.mock.calls[0][1].attrs.content).toContain('撤回失败')

    await handlers.get('guild-member-request')!(session())
    expect(send.mock.calls[1][1].attrs.content).toContain('此前触发关键词 1 次')
  })

  it('applies the existing command whitelist only in monitored groups', async () => {
    const { handlers, session } = setup()
    const before = handlers.get('command/execute')!
    expect(
      await before({ command: { name: 'wiki.search' }, session: session() })
    ).toBeUndefined()
    expect(
      await before({ command: { name: 'version' }, session: session() })
    ).toBe('')
    expect(
      await before({
        command: { name: 'version' },
        session: session('m2', { getUser: async () => ({ authority: 2 }) }),
      })
    ).toBeUndefined()
  })
})
