import { describe, expect, it } from 'vitest'

import type { MWPage, MWUser } from '../types/MediaWiki'
import {
  buildUserInfoboxPayload,
  formatContribTime,
  formatDate,
  formatExpiry,
  isUserRootPage,
  normalizeGroups,
} from '../user-infobox/payload'

const page = (over: Partial<MWPage>): MWPage =>
  ({ pageid: 1, ns: 2, title: 'User:Foo', canonicalurl: '', ...over }) as MWPage

const user = (over: Partial<MWUser>): MWUser =>
  ({ userid: 1, name: 'Foo', ...over }) as MWUser

describe('formatDate (UTC+8)', () => {
  it('shifts UTC into UTC+8', () => {
    // 19:08 UTC + 8h = 次日
    expect(formatDate('2004-05-20T19:08:13Z')).toBe('2004-05-21')
  })
})

describe('formatContribTime (UTC+8)', () => {
  const now = new Date('2026-10-10T06:00:00Z')

  it('shows MM-DD HH:mm within the current year', () => {
    // 19:08 UTC + 8h = 次日 03:08
    expect(formatContribTime('2026-05-20T19:08:13Z', now)).toBe('05-21 03:08')
  })

  it('shows YYYY-MM-DD for a previous year', () => {
    expect(formatContribTime('2025-12-30T02:00:00Z', now)).toBe('2025-12-30')
  })

  it('compares years in UTC+8, not UTC', () => {
    // 2025-12-31 17:00 UTC = 2026-01-01 01:00 UTC+8 → same year as now
    expect(formatContribTime('2025-12-31T17:00:00Z', now)).toBe('01-01 01:00')
    // now = 2026-12-31 17:00 UTC is already 2027 in UTC+8
    const newYear = new Date('2026-12-31T17:00:00Z')
    expect(formatContribTime('2026-12-31T10:00:00Z', newYear)).toBe(
      '2026-12-31'
    )
  })
})

describe('formatExpiry', () => {
  it('maps indefinite blocks to 永久', () => {
    for (const v of ['infinity', 'infinite', 'indefinite', 'never']) {
      expect(formatExpiry(v)).toBe('永久')
    }
  })
  it('formats a real expiry date as UTC+8', () => {
    expect(formatExpiry('2025-01-01T00:00:00Z')).toBe('2025-01-01')
  })
  it('returns empty string for undefined', () => {
    expect(formatExpiry(undefined)).toBe('')
  })
})

describe('normalizeGroups', () => {
  it('drops implicit * and user groups', () => {
    expect(normalizeGroups(['*', 'user', 'sysop'])).toEqual(['管理员'])
  })
  it('drops non-whitelisted technical groups', () => {
    expect(
      normalizeGroups(['abusefilter', 'autoconfirmed', 'flow-bot', 'sysop'])
    ).toEqual(['管理员'])
  })
  it('drops unknown custom groups entirely (no raw English passthrough)', () => {
    expect(normalizeGroups(['sysop', 'custom-group'])).toEqual(['管理员'])
  })
  it('dedupes groups mapping to the same name (oversight + suppress)', () => {
    expect(normalizeGroups(['oversight', 'suppress'])).toEqual(['监督员'])
  })
  it('returns empty array when nothing is whitelisted', () => {
    expect(normalizeGroups(['*', 'user', 'autoconfirmed'])).toEqual([])
  })
})

describe('buildUserInfoboxPayload', () => {
  it('maps a normal user', () => {
    const p = buildUserInfoboxPayload(
      user({
        userid: 12450,
        name: 'Dragon-Fish',
        editcount: 12345,
        registration: '2016-08-12T02:00:00Z',
        groups: ['*', 'user', 'sysop', 'interface-admin'],
      }),
      [
        {
          userid: 12450,
          user: 'Dragon-Fish',
          ns: 0,
          title: '初音未来',
          timestamp: '2026-07-16T06:22:00Z',
        },
        {
          userid: 12450,
          user: 'Dragon-Fish',
          ns: 0,
          title: '沙盒',
          timestamp: '2025-03-01T00:00:00Z',
        },
      ],
      {
        avatar: 'data:image/png;base64,AAAA',
        sitename: '萌娘百科',
        pageUrl: 'https://zh.moegirl.org.cn/User:%E5%B0%8F%E9%B1%BC',
        now: new Date('2026-10-10T06:00:00Z'),
      }
    )
    expect(p).toMatchObject({
      sitename: '萌娘百科',
      link: 'zh.moegirl.org.cn/User:小鱼',
      name: 'Dragon-Fish',
      userid: 12450,
      avatar: 'data:image/png;base64,AAAA',
      registration: '2016-08-12',
      editcount: 12345,
      groups: ['管理员', '界面管理员'],
      block: null,
    })
    expect(p.contribs).toEqual([
      { title: '初音未来', time: '07-16 14:22' },
      { title: '沙盒', time: '2025-03-01' },
    ])
  })

  it('handles null registration (legacy account)', () => {
    const p = buildUserInfoboxPayload(user({ registration: null }), [])
    expect(p.registration).toBeNull()
  })

  it('avatar defaults to null when no URL given', () => {
    const p = buildUserInfoboxPayload(user({}), [])
    expect(p.avatar).toBeNull()
  })

  it('surfaces block info', () => {
    const p = buildUserInfoboxPayload(
      user({
        blockedby: 'Admin',
        blockreason: '破坏页面',
        blockexpiry: 'infinity',
      }),
      []
    )
    expect(p.block).toEqual({ by: 'Admin', reason: '破坏页面', expiry: '永久' })
  })

  it('caps contribs at 3', () => {
    const contribs = Array.from({ length: 5 }, (_, i) => ({
      userid: 1,
      user: 'Foo',
      ns: 0,
      title: `P${i}`,
      timestamp: '2026-07-16T00:00:00Z',
    }))
    const p = buildUserInfoboxPayload(user({}), contribs)
    expect(p.contribs).toHaveLength(3)
  })
})

describe('isUserRootPage', () => {
  it('accepts a ns=2 root page', () => {
    expect(isUserRootPage(page({ ns: 2, title: 'User:Foo' }))).toBe(true)
  })
  it('rejects subpages', () => {
    expect(isUserRootPage(page({ ns: 2, title: 'User:Foo/sandbox' }))).toBe(
      false
    )
  })
  it('rejects non-user namespaces', () => {
    expect(isUserRootPage(page({ ns: 0, title: 'Foo' }))).toBe(false)
    expect(isUserRootPage(page({ ns: 3, title: 'User talk:Foo' }))).toBe(false)
  })
  it('rejects invalid titles (e.g. IP handled upstream)', () => {
    expect(
      isUserRootPage(page({ ns: 2, title: 'User:Foo', invalid: true }))
    ).toBe(false)
  })
  it('accepts localized namespace prefix', () => {
    expect(isUserRootPage(page({ ns: 2, title: '用户:Foo' }))).toBe(true)
  })
})
