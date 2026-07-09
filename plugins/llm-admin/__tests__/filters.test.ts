import { describe, expect, it } from 'vitest'

import { matchUser, paginate } from '../filters'

const u = { id: 42, name: '爸爸', account: 'qq:100863' }

describe('matchUser', () => {
  it('matches exact #id and bare id', () => {
    expect(matchUser(u, '#42')).toBe(true)
    expect(matchUser(u, '42')).toBe(true)
    expect(matchUser(u, '4')).toBe(false) // id 精确匹配非子串；account/name 也不含 '4'，隔离该行为
  })
  it('matches account and name substrings, case-insensitive', () => {
    expect(matchUser(u, '0086')).toBe(true)
    expect(matchUser(u, 'QQ:')).toBe(true)
    expect(matchUser(u, '爸')).toBe(true)
    expect(matchUser(u, 'zzz')).toBe(false)
  })
  it('empty query matches all', () => {
    expect(matchUser(u, '')).toBe(true)
    expect(matchUser(u, '  ')).toBe(true)
  })
})

describe('paginate', () => {
  const arr = [1, 2, 3, 4, 5]
  it('returns total and the requested window', () => {
    expect(paginate(arr, 2, 0)).toEqual({ total: 5, page: [1, 2] })
    expect(paginate(arr, 2, 2)).toEqual({ total: 5, page: [3, 4] })
    expect(paginate(arr, 2, 4)).toEqual({ total: 5, page: [5] })
  })
  it('offset past end yields empty page but real total', () => {
    expect(paginate(arr, 2, 10)).toEqual({ total: 5, page: [] })
  })
})
