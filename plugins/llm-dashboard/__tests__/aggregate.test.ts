import { describe, expect, it } from 'vitest'

import { type UsageRow, aggregateStats } from '../aggregate'

const DAY = 86_400_000
const now = 1_752_000_000_000

function row(partial: Partial<UsageRow> = {}): UsageRow {
  return {
    time: now - DAY,
    model: 'gpt-4o',
    conversation_owner: 1,
    conversation_id: 'c1',
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    ...partial,
  }
}

const identityOf = (id: number) =>
  ({
    1: { name: 'Alice', account: 'onebot:1001' },
    2: { name: 'Bob', account: 'onebot:2002' },
  })[id] ?? { name: '', account: '' }

describe('aggregateStats', () => {
  it('aggregates the current-window overview', () => {
    const stats = aggregateStats(
      [
        row({ conversation_owner: 1, conversation_id: 'c1' }),
        row({
          conversation_owner: 2,
          conversation_id: 'c2',
          usage: {
            promptTokens: 200,
            completionTokens: 100,
            totalTokens: 300,
            cachedTokens: 80,
          },
        }),
      ],
      7,
      now,
      identityOf
    )
    expect(stats.overview.calls).toBe(2)
    expect(stats.overview.totalTokens).toBe(450)
    expect(stats.overview.promptTokens).toBe(300)
    expect(stats.overview.completionTokens).toBe(150)
    // cachedTokens is summed for display but never folded into totalTokens.
    expect(stats.overview.cachedTokens).toBe(80)
    expect(stats.overview.activeUsers).toBe(2)
    expect(stats.overview.conversations).toBe(2)
  })

  it('separates the previous equal-length window', () => {
    const stats = aggregateStats(
      [row({ time: now - DAY }), row({ time: now - 9 * DAY })],
      7,
      now,
      identityOf
    )
    expect(stats.overview.calls).toBe(1)
    expect(stats.overview.prev.calls).toBe(1)
  })

  it('ranks models by total tokens descending', () => {
    const stats = aggregateStats(
      [
        row({
          model: 'gpt-4o',
          usage: { promptTokens: 80, completionTokens: 20, totalTokens: 100 },
        }),
        row({
          model: 'claude-sonnet-4-6',
          usage: { promptTokens: 400, completionTokens: 100, totalTokens: 500 },
        }),
        row({
          model: 'gpt-4o',
          usage: { promptTokens: 80, completionTokens: 20, totalTokens: 100 },
        }),
      ],
      7,
      now,
      identityOf
    )
    expect(stats.models[0]).toEqual({
      model: 'claude-sonnet-4-6',
      calls: 1,
      totalTokens: 500,
      promptTokens: 400,
      completionTokens: 100,
    })
    expect(stats.models[1]).toEqual({
      model: 'gpt-4o',
      calls: 2,
      totalTokens: 200,
      promptTokens: 160,
      completionTokens: 40,
    })
  })

  it('ranks top users with identity (name + account) and distinct conversation counts', () => {
    const stats = aggregateStats(
      [
        row({
          conversation_owner: 1,
          conversation_id: 'a',
          usage: { totalTokens: 100 },
        }),
        row({
          conversation_owner: 1,
          conversation_id: 'b',
          usage: { totalTokens: 100 },
        }),
        row({
          conversation_owner: 2,
          conversation_id: 'c',
          usage: { totalTokens: 50 },
        }),
      ],
      7,
      now,
      identityOf
    )
    expect(stats.users[0]).toEqual({
      id: 1,
      name: 'Alice',
      account: 'onebot:1001',
      totalTokens: 200,
      conversations: 2,
    })
    expect(stats.users[1]).toEqual({
      id: 2,
      name: 'Bob',
      account: 'onebot:2002',
      totalTokens: 50,
      conversations: 1,
    })
  })

  it('leaves name/account empty for owners the resolver cannot identify', () => {
    const stats = aggregateStats(
      [row({ conversation_owner: 99, usage: { totalTokens: 10 } })],
      7,
      now,
      identityOf
    )
    expect(stats.users[0]).toEqual({
      id: 99,
      name: '',
      account: '',
      totalTokens: 10,
      conversations: 1,
    })
  })

  it('falls back to total = prompt + completion when totalTokens missing', () => {
    const stats = aggregateStats(
      [row({ usage: { promptTokens: 30, completionTokens: 20 } })],
      7,
      now,
      identityOf
    )
    expect(stats.overview.totalTokens).toBe(50)
  })

  it('handles null usage rows without throwing', () => {
    const stats = aggregateStats([row({ usage: null })], 7, now, identityOf)
    expect(stats.overview.calls).toBe(1)
    expect(stats.overview.totalTokens).toBe(0)
  })

  it('emits a continuous daily trend whose calls sum to the window total', () => {
    const stats = aggregateStats([row({ time: now - DAY })], 7, now, identityOf)
    expect(stats.trend.length).toBeGreaterThanOrEqual(7)
    expect(stats.trend.reduce((s, d) => s + d.calls, 0)).toBe(1)
  })

  it('trend dates are strictly consecutive calendar days (no gaps, no duplicates)', () => {
    const stats = aggregateStats([row({ time: now - DAY })], 7, now, identityOf)
    // Parse YYYY-MM-DD as a local calendar day and assert each next = prev + 1 day.
    const asDay = (s: string) => {
      const [y, m, d] = s.split('-').map(Number)
      return new Date(y, m - 1, d)
    }
    for (let i = 1; i < stats.trend.length; i++) {
      const prev = asDay(stats.trend[i - 1].date)
      const cur = asDay(stats.trend[i].date)
      const expected = new Date(
        prev.getFullYear(),
        prev.getMonth(),
        prev.getDate() + 1
      )
      expect(cur.getFullYear()).toBe(expected.getFullYear())
      expect(cur.getMonth()).toBe(expected.getMonth())
      expect(cur.getDate()).toBe(expected.getDate())
    }
    // No duplicate date keys.
    expect(new Set(stats.trend.map((d) => d.date)).size).toBe(
      stats.trend.length
    )
  })

  it('sums trend calls to the total row count and matches each populated day', () => {
    const rows = [
      row({ time: now - DAY }),
      row({ time: now - DAY }),
      row({ time: now - 3 * DAY }),
      row({ time: now - 5 * DAY }),
    ]
    const stats = aggregateStats(rows, 7, now, identityOf)

    // Every row falls on a distinct-or-shared local day inside the window.
    const total = stats.trend.reduce((s, d) => s + d.calls, 0)
    expect(total).toBe(rows.length)

    // Each populated day's call count matches the rows landing on that day.
    const expectedByDay = new Map<string, number>()
    const toKey = (t: number) => {
      const d = new Date(t)
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const day = String(d.getDate()).padStart(2, '0')
      return `${d.getFullYear()}-${m}-${day}`
    }
    for (const r of rows)
      expectedByDay.set(
        toKey(r.time),
        (expectedByDay.get(toKey(r.time)) ?? 0) + 1
      )
    for (const d of stats.trend) {
      expect(d.calls).toBe(expectedByDay.get(d.date) ?? 0)
    }
  })
})
