import { describe, expect, it } from 'vitest'

import {
  CODE_TTL,
  type VerifySource,
  parseAnswer,
  sha1,
  verifyAnswer,
} from '../verify'

const CODE = '0123456789ABCDEF'
const NOW = 1_800_000_000_000
const T = NOW - 60_000

function source(over: Partial<VerifySource> = {}): VerifySource {
  return {
    userName: async (id) => (id === 32769624 ? 'Foo Bar' : undefined),
    verifyPage: async () => ({
      content: `${T}#${sha1(`${T}#${CODE}`)}`,
      editor: 'Foo_Bar',
    }),
    isUsed: async () => false,
    ...over,
  }
}

const reasonOf = async (content: string, src = source(), now = NOW) => {
  const result = await verifyAnswer(content, src, now)
  return 'reason' in result ? result.reason : 'ok'
}

describe('parseAnswer', () => {
  it('finds the answer inside the question text, case-insensitively', () => {
    expect(
      parseAnswer(`你的 Fandom 验证码: 32769624-${CODE.toLowerCase()}`)
    ).toEqual({ wikiUserId: 32769624, code: CODE })
  })
  it('rejects letters outside the Crockford alphabet', () => {
    expect(parseAnswer('32769624-0123456789ABCDEI')).toBeUndefined()
  })
})

describe('verifyAnswer', () => {
  it('accepts a fresh, matching, unused code', async () => {
    expect(await verifyAnswer(`32769624-${CODE}`, source(), NOW)).toMatchObject(
      {
        ok: true,
        wikiUserName: 'Foo Bar',
      }
    )
  })

  it('reports each failure', async () => {
    expect(await reasonOf('hello')).toContain('没有验证码')
    expect(await reasonOf(`1-${CODE}`)).toContain('用户 ID 不存在')
    expect(
      await reasonOf(
        `32769624-${CODE}`,
        source({ verifyPage: async () => undefined })
      )
    ).toContain('还没生成验证码')
    expect(
      await reasonOf(
        `32769624-${CODE}`,
        source({
          verifyPage: async () => ({ content: '', editor: 'Someone' }),
        })
      )
    ).toContain('不是本人编辑')
    expect(
      await reasonOf(`32769624-${CODE}`, source(), T + CODE_TTL + 1)
    ).toContain('已过期')
    expect(await reasonOf('32769624-FEDCBA9876543210')).toContain('对不上')
    expect(
      await reasonOf(
        `32769624-${CODE}`,
        source({
          verifyPage: async () => ({ content: `${T}#x#y`, editor: 'Foo Bar' }),
        })
      )
    ).toContain('对不上')
    expect(
      await reasonOf(`32769624-${CODE}`, source({ isUsed: async () => true }))
    ).toContain('用过')
  })
})
