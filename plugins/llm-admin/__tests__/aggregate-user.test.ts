import { describe, expect, it } from 'vitest'

import { type UserUsageRow, aggregateUserOverview } from '../aggregate-user'

const DAY = 86_400_000
const now = 1_752_000_000_000
const idt = { id: 1, name: 'Alice', account: 'qq:100' }

function row(p: Partial<UserUsageRow> = {}): UserUsageRow {
  return { time: now - DAY, model: 'gpt-4o', usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, ...p }
}

describe('aggregateUserOverview', () => {
  it('sums tokens without double-counting cached', () => {
    const o = aggregateUserOverview(
      [row({ usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300, cachedTokens: 80 } })],
      3, idt, now
    )
    expect(o.calls).toBe(1)
    expect(o.totalTokens).toBe(300)
    expect(o.promptTokens).toBe(200)
    expect(o.completionTokens).toBe(100)
    expect(o.cachedTokens).toBe(80)
    expect(o.sessionCount).toBe(3)
    expect(o.id).toBe(1)
    expect(o.name).toBe('Alice')
    expect(o.account).toBe('qq:100')
  })

  it('falls back total = prompt + completion when totalTokens missing', () => {
    const o = aggregateUserOverview([row({ usage: { promptTokens: 30, completionTokens: 20 } })], 0, idt, now)
    expect(o.totalTokens).toBe(50)
  })

  it('handles null usage without throwing', () => {
    const o = aggregateUserOverview([row({ usage: null })], 0, idt, now)
    expect(o.calls).toBe(1)
    expect(o.totalTokens).toBe(0)
  })

  it('ranks models by total tokens desc', () => {
    const o = aggregateUserOverview(
      [
        row({ model: 'a', usage: { totalTokens: 100 } }),
        row({ model: 'b', usage: { totalTokens: 500 } }),
        row({ model: 'a', usage: { totalTokens: 100 } }),
      ],
      0, idt, now
    )
    expect(o.models[0]).toEqual({ model: 'b', calls: 1, totalTokens: 500 })
    expect(o.models[1]).toEqual({ model: 'a', calls: 2, totalTokens: 200 })
  })

  it('tracks first/last active', () => {
    const o = aggregateUserOverview([row({ time: now - 5 * DAY }), row({ time: now - DAY })], 0, idt, now)
    expect(o.firstActive).toBe(now - 5 * DAY)
    expect(o.lastActive).toBe(now - DAY)
  })

  it('builds a continuous daily trend over rangeDays whose length covers the window', () => {
    const o = aggregateUserOverview([row({ time: now - DAY })], 0, idt, now, 30)
    expect(o.trend.length).toBeGreaterThanOrEqual(30)
    const keys = new Set(o.trend.map((d) => d.date))
    expect(keys.size).toBe(o.trend.length) // no duplicate days
  })

  it('leaves overview zeroed for a user with no rows', () => {
    const o = aggregateUserOverview([], 0, idt, now)
    expect(o.calls).toBe(0)
    expect(o.firstActive).toBeNull()
    expect(o.models).toEqual([])
  })
})
