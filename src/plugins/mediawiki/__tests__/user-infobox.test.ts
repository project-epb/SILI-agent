import { describe, expect, it } from 'vitest'

import type { MWPage, MWUser } from '../types/MediaWiki'
import {
  buildUserInfoboxPayload,
  formatDate,
  formatDateTime,
  formatExpiry,
  isUserRootPage,
  normalizeGroups,
} from '../user-infobox/payload'

const page = (over: Partial<MWPage>): MWPage =>
  ({ pageid: 1, ns: 2, title: 'User:Foo', canonicalurl: '', ...over }) as MWPage

const user = (over: Partial<MWUser>): MWUser =>
  ({ userid: 1, name: 'Foo', ...over }) as MWUser

describe('formatDate / formatDateTime (UTC+8)', () => {
  it('shifts UTC into UTC+8', () => {
    // 19:08 UTC + 8h = 次日 03:08
    expect(formatDate('2004-05-20T19:08:13Z')).toBe('2004-05-21')
    expect(formatDateTime('2004-05-20T19:08:13Z')).toBe('05-21 03:08')
  })

  it('keeps same day when shift does not cross midnight', () => {
    expect(formatDateTime('2016-08-12T02:00:00Z')).toBe('08-12 10:00')
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
      [{ userid: 12450, user: 'Dragon-Fish', ns: 0, title: '初音未来', timestamp: '2026-07-16T06:22:00Z' }],
      'https://example.com/a.png'
    )
    expect(p).toMatchObject({
      name: 'Dragon-Fish',
      userid: 12450,
      avatar: 'https://example.com/a.png',
      registration: '2016-08-12',
      editcount: 12345,
      groups: ['管理员', '界面管理员'],
      block: null,
    })
    expect(p.contribs).toEqual([{ title: '初音未来', time: '07-16 14:22' }])
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
    expect(isUserRootPage(page({ ns: 2, title: 'User:Foo/sandbox' }))).toBe(false)
  })
  it('rejects non-user namespaces', () => {
    expect(isUserRootPage(page({ ns: 0, title: 'Foo' }))).toBe(false)
    expect(isUserRootPage(page({ ns: 3, title: 'User talk:Foo' }))).toBe(false)
  })
  it('rejects invalid titles (e.g. IP handled upstream)', () => {
    expect(isUserRootPage(page({ ns: 2, title: 'User:Foo', invalid: true }))).toBe(false)
  })
  it('accepts localized namespace prefix', () => {
    expect(isUserRootPage(page({ ns: 2, title: '用户:Foo' }))).toBe(true)
  })
})
