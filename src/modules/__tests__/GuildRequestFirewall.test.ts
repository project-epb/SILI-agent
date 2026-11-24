import { describe, expect, it, vi } from 'vitest'

import { GuildRequestFirewall } from '../GuildRequestFirewall'

vi.mock('koishi', () => ({ snakeCase: (name: string) => name }))

function session(content: string, info?: object) {
  return {
    platform: 'qq',
    content,
    messageId: 'request',
    channelId: 'group',
    event: info ? { _data: { d: { verify_info: info } } } : {},
    bot: {
      handleGuildMemberRequest: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue([]),
    },
  }
}

describe('GuildRequestFirewall', () => {
  it('uses official QQ answers and ignores the question text', () => {
    expect(
      GuildRequestFirewall.matches(
        session('题目：通过一下', {
          verify_message: '',
          review_qa_list: [{ question: '通过一下', answer: 'a'.repeat(64) }],
        }) as any
      )
    ).toBe(false)
    expect(
      GuildRequestFirewall.matches(
        session('', {
          verify_message: '',
          review_qa_list: [{ question: '为什么进群', answer: '交流学习' }],
        }) as any
      )
    ).toBe(true)
  })

  it('keeps the legacy answer prefix fallback and can also read bare text', () => {
    expect(
      GuildRequestFirewall.matches(
        session('问题：通过一下\n答案：正常答案') as any
      )
    ).toBe(false)
    expect(
      GuildRequestFirewall.matches(
        session('问题：进群动机\n答案：朋友推荐') as any
      )
    ).toBe(true)
    expect(GuildRequestFirewall.matches(session('请同意') as any)).toBe(true)
  })

  it('rejects a matching request and sends the notice to its group', async () => {
    let onRequest: (value: ReturnType<typeof session>) => Promise<void>
    const channel = { on: (_, handler) => (onRequest = handler) }
    new GuildRequestFirewall({ channel: () => channel } as any)

    const incoming = session('通过一下')
    await onRequest(incoming)
    expect(incoming.bot.handleGuildMemberRequest).toHaveBeenCalledWith(
      'request',
      false,
      ''
    )
    expect(incoming.bot.sendMessage).toHaveBeenCalledWith(
      'group',
      expect.stringContaining('拒绝')
    )
  })
})
