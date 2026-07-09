import { describe, expect, it } from 'vitest'

import { turnWindow } from '../turns'

describe('turnWindow', () => {
  const turns = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  it('takes the most recent `limit` turns when beforeTurn is null', () => {
    expect(turnWindow(turns, 3, null)).toEqual({ fromTurn: 8, hasMore: true })
  })
  it('takes `limit` turns strictly before the cursor', () => {
    expect(turnWindow(turns, 3, 8)).toEqual({ fromTurn: 5, hasMore: true })
  })
  it('clamps at the beginning and reports hasMore=false', () => {
    expect(turnWindow(turns, 3, 3)).toEqual({ fromTurn: 1, hasMore: false })
    expect(turnWindow(turns, 20, null)).toEqual({ fromTurn: 1, hasMore: false })
  })
  it('empty conversation', () => {
    expect(turnWindow([], 3, null)).toEqual({ fromTurn: null, hasMore: false })
  })
})
