import { describe, it, expect } from 'vitest'

import { extractList } from '../client'

describe('extractList', () => {
  it('returns the keyed array when payload is a dict (e.g. {@attributes, post:[...]})', () => {
    const payload = { '@attributes': { count: 2 }, post: [{ id: 1 }, { id: 2 }] }
    expect(extractList(payload, 'post')).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('returns the payload unchanged when it is already a bare array', () => {
    const payload = [{ id: 1 }, { id: 2 }]
    expect(extractList(payload, 'post')).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('returns [] when the dict lacks the requested key', () => {
    const payload = { '@attributes': { count: 0 } }
    expect(extractList(payload, 'post')).toEqual([])
  })

  it('returns [] when the keyed value is null', () => {
    const payload = { post: null }
    expect(extractList(payload, 'post')).toEqual([])
  })

  it('returns [] for non-dict / non-array payloads', () => {
    expect(extractList(null, 'tag')).toEqual([])
    expect(extractList(undefined, 'tag')).toEqual([])
    expect(extractList('oops', 'tag')).toEqual([])
  })

  it('works for the tag key too', () => {
    const payload = { tag: [{ name: 'fox_girl', count: 100 }] }
    expect(extractList(payload, 'tag')).toEqual([{ name: 'fox_girl', count: 100 }])
  })
})
