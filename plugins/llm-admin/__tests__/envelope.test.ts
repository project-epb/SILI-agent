import { describe, expect, it } from 'vitest'

import { parseEnvelopes, splitSteer } from '../envelope'

const env = (user: object, text: string) =>
  `<turn_context>\n${JSON.stringify({ koishi: {}, platform: { user } })}\n</turn_context>\n<user_message>\n${text}\n</user_message>`

describe('parseEnvelopes', () => {
  it('reads the speaker and text of one envelope', () => {
    expect(parseEnvelopes(env({ name: '路人甲' }, '在吗'))).toEqual([
      { speaker: '路人甲', text: '在吗' },
    ])
  })

  it('keeps every message of a row that opens with a backlog', () => {
    const row = `${env({ name: 'A' }, '一')}\n\n${env({ name: 'B', group_nickname: '群名片B' }, '二')}`
    expect(parseEnvelopes(row)).toEqual([
      { speaker: 'A', text: '一' },
      { speaker: '群名片B', text: '二' },
    ])
  })

  it('returns a legacy raw row whole', () => {
    expect(parseEnvelopes('裸文本')).toEqual([{ speaker: '', text: '裸文本' }])
  })
})

describe('splitSteer', () => {
  it('separates steered messages from the tool output', () => {
    const content = `查询结果\n\n<steer_notice>\n忙着的时候来的\n</steer_notice>\n\n${env({ name: 'B' }, '插一句')}`
    expect(splitSteer(content)).toEqual({
      tool: '查询结果',
      steered: [{ speaker: 'B', text: '插一句' }],
    })
  })

  it('leaves a plain tool result alone', () => {
    expect(splitSteer('结果')).toEqual({ tool: '结果', steered: [] })
  })
})
