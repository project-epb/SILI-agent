import { describe, expect, it } from 'vitest'

import {
  CODE_TTL,
  type Policy,
  type VerifySource,
  type WikiUser,
  bindOnApproval,
  decide,
  parseAnswer,
  sha1,
} from '../verify'

const CODE = '0123456789ABCDEF'
const NOW = 1_800_000_000_000
const T = NOW - 60_000
const HASH = sha1(`${T}#${CODE}`)
const ANSWER = `32769624-${CODE}`

const users: Record<number, WikiUser> = {
  32769624: {
    id: 32769624,
    name: 'Foo Bar',
    groups: ['user', 'autoconfirmed'],
    memberships: [],
    blocked: false,
  },
  7: {
    id: 7,
    name: 'Old',
    groups: ['user', 'autoconfirmed', 'sysop'],
    memberships: [{ group: 'sysop', expiry: 'infinity' }],
    blocked: false,
  },
}

function source(over: Partial<VerifySource> = {}): VerifySource {
  return {
    user: async (id) => users[id],
    verifyPage: async () => ({ content: `${T}#${HASH}`, editor: 'Foo_Bar' }),
    codeSpentBy: async () => undefined,
    boundTo: async () => undefined,
    boundOpenids: async () => [],
    groupAddedAt: async () => undefined,
    ...over,
  }
}

const policy = (groups: string[] = []): Policy => ({
  label: '萌娘百科',
  groups,
})

const reasonOf = async (
  content: string,
  src = source(),
  now = NOW,
  p = policy()
) => {
  const result = await decide(content, 'me', src, p, now)
  return 'reason' in result ? result.reason : 'ok'
}

describe('parseAnswer', () => {
  it('finds the answer inside the question text, case-insensitively', () => {
    expect(parseAnswer(`你的验证码: 32769624-${CODE.toLowerCase()}`)).toEqual({
      wikiUserId: 32769624,
      code: CODE,
    })
  })
  it('rejects letters outside the Crockford alphabet', () => {
    expect(parseAnswer('32769624-0123456789ABCDEI')).toBeUndefined()
  })
})

describe('decide', () => {
  it('accepts a fresh code and binds it, spending the code', async () => {
    expect(await decide(ANSWER, 'me', source(), policy(), NOW)).toMatchObject({
      ok: true,
      bind: { wikiUserId: 32769624, wikiUserName: 'Foo Bar', hash: HASH },
    })
  })

  it('reports each code failure for an unbound applicant', async () => {
    expect(await reasonOf('hello')).toContain('没有验证码')
    expect(await reasonOf(`1-${CODE}`)).toContain('用户 ID 不存在')
    expect(
      await reasonOf(ANSWER, source({ verifyPage: async () => undefined }))
    ).toContain('还没生成验证码')
    expect(
      await reasonOf(
        ANSWER,
        source({ verifyPage: async () => ({ content: '', editor: 'Someone' }) })
      )
    ).toContain('不是本人编辑')
    expect(await reasonOf(ANSWER, source(), T + CODE_TTL + 1)).toContain(
      '已过期'
    )
    expect(await reasonOf('32769624-FEDCBA9876543210')).toContain('对不上')
    expect(
      await reasonOf(ANSWER, source({ codeSpentBy: async () => 'other' }))
    ).toContain('用过')
  })

  it('lets the applicant who spent a code use it again, without spending it twice', async () => {
    const result = await decide(
      ANSWER,
      'me',
      source({ codeSpentBy: async () => 'me', boundTo: async () => 32769624 }),
      policy(),
      NOW
    )
    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.bind?.hash).toBeUndefined()
  })

  it('stands an existing binding in for a missing or broken code', async () => {
    const bound = source({ boundTo: async () => 7 })
    expect(await decide('随便', 'me', bound, policy(), NOW)).toMatchObject({
      ok: true,
      user: { name: 'Old' },
    })
    expect(
      await decide(
        ANSWER,
        'me',
        { ...bound, codeSpentBy: async () => 'other' },
        policy(),
        NOW
      )
    ).toMatchObject({ ok: true, user: { name: 'Old' } })
  })

  it('sends the first extra QQ of a bound account to a human', async () => {
    expect(
      await reasonOf(ANSWER, source({ boundOpenids: async () => ['other'] }))
    ).toContain('已绑定另一个 QQ')
    // Already bound to this applicant: no question.
    expect(
      await reasonOf(
        ANSWER,
        source({
          boundTo: async () => 32769624,
          boundOpenids: async () => ['me', 'other'],
        })
      )
    ).toBe('ok')
  })

  it('switches a QQ to the account of a new valid code', async () => {
    expect(
      await decide(
        ANSWER,
        'me',
        source({ boundTo: async () => 7 }),
        policy(),
        NOW
      )
    ).toMatchObject({
      ok: true,
      user: { name: 'Foo Bar' },
      bind: { wikiUserId: 32769624 },
    })
  })

  it('checks group requirements and blocks on the live account', async () => {
    expect(await reasonOf(ANSWER, source(), NOW, policy(['sysop']))).toContain(
      '不满足本群要求'
    )
    expect(
      await reasonOf(ANSWER, source(), NOW, policy(['sysop', 'autoconfirmed']))
    ).toBe('ok')
    expect(
      await reasonOf(
        '随便',
        source({
          boundTo: async () => 7,
          user: async (id) => ({ ...users[id], blocked: true }),
        })
      )
    ).toContain('封禁')
  })
})

describe('temporary group minimum', () => {
  const DAY = 24 * 60 * 60 * 1000
  const TEMP = '2099-01-01T00:00:00Z'
  const patroller =
    (expiry: string): VerifySource['user'] =>
    async (id) => ({
      ...users[id],
      groups: [...users[id].groups, 'patroller'],
      memberships: [{ group: 'patroller', expiry }],
    })
  const p: Policy = { label: '萌娘百科', groups: ['patroller'], tempMinDays: 7 }
  const run = (src: VerifySource) => reasonOf(ANSWER, src, NOW, p)

  it('admits a permanent membership at once', async () => {
    expect(await run(source({ user: patroller('infinity') }))).toBe('ok')
  })
  it('admits a temporary membership held long enough', async () => {
    expect(
      await run(
        source({
          user: patroller(TEMP),
          groupAddedAt: async () => NOW - 7 * DAY,
        })
      )
    ).toBe('ok')
  })
  it('sends a fresh or untraceable temporary membership to a human', async () => {
    expect(
      await run(
        source({
          user: patroller(TEMP),
          groupAddedAt: async () => NOW - 6 * DAY,
        })
      )
    ).toContain('持有不足 7 天')
    expect(await run(source({ user: patroller(TEMP) }))).toContain(
      '持有不足 7 天'
    )
  })
})

describe('bindOnApproval', () => {
  it('binds an expired but matching code', async () => {
    expect(await bindOnApproval(ANSWER, 'me', source(), policy())).toEqual({
      wikiUserId: 32769624,
      wikiUserName: 'Foo Bar',
      hash: HASH,
    })
  })
  it('binds nothing when someone else spent the code or there is none', async () => {
    expect(
      await bindOnApproval(
        ANSWER,
        'me',
        source({ codeSpentBy: async () => 'other' }),
        policy()
      )
    ).toBeUndefined()
    expect(
      await bindOnApproval('hello', 'me', source(), policy())
    ).toBeUndefined()
  })
})
