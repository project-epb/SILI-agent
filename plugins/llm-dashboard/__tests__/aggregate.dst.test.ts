// This DST regression test is isolated in its own file so the timezone lock is
// unambiguous: V8's Date reads process.env.TZ when a Date is *created*, so we
// must set TZ before any `new Date(...)` in aggregateStats or the assertions run.
// Locking TZ here (and restoring it after) keeps the fixed timestamp window truly
// spanning the 2025-03-09 02:00 EST->EDT spring-forward regardless of host TZ.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

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

const nameOf = (id: number) => ({ 1: 'Alice', 2: 'Bob' })[id] ?? `#${id}`

describe('aggregateStats DST', () => {
  let prevTZ: string | undefined

  beforeAll(() => {
    prevTZ = process.env.TZ
    process.env.TZ = 'America/New_York'
  })

  afterAll(() => {
    if (prevTZ === undefined) delete process.env.TZ
    else process.env.TZ = prevTZ
  })

  it('does not skip a local calendar day across a DST transition', () => {
    // Regression: a fixed-86_400_000ms step lands at the same wall-clock time each
    // day and can skip a local calendar day across a DST spring-forward, dropping
    // that day's rows. In America/New_York, a 7-day window starting Thu Mar 06 2025
    // 23:23 EST spans the 2025-03-09 02:00 EST->EDT transition; the old fixed-ms
    // loop omitted 2025-03-09 entirely.
    const curStart = 1_741_321_380_000 // Thu Mar 06 2025 23:23:00 GMT-0500
    const dstNow = curStart + 7 * DAY

    const asDay = (s: string) => {
      const [y, m, d] = s.split('-').map(Number)
      return new Date(y, m - 1, d)
    }
    const toKey = (t: number) => {
      const d = new Date(t)
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const day = String(d.getDate()).padStart(2, '0')
      return `${d.getFullYear()}-${m}-${day}`
    }

    // Place one row on each local day of the window so a skipped day would drop rows.
    const rows: UsageRow[] = []
    for (let t = curStart; t <= dstNow; t += DAY) rows.push(row({ time: t }))

    const stats = aggregateStats(rows, 7, dstNow, nameOf)

    // Consecutive calendar days, no gaps, no duplicates.
    for (let i = 1; i < stats.trend.length; i++) {
      const prev = asDay(stats.trend[i - 1].date)
      const cur = asDay(stats.trend[i].date)
      const expected = new Date(
        prev.getFullYear(),
        prev.getMonth(),
        prev.getDate() + 1
      )
      expect([cur.getFullYear(), cur.getMonth(), cur.getDate()]).toEqual([
        expected.getFullYear(),
        expected.getMonth(),
        expected.getDate(),
      ])
    }

    // Every row's local day is present in the trend (no dropped rows).
    const trendKeys = new Set(stats.trend.map((d) => d.date))
    for (const r of rows) expect(trendKeys.has(toKey(r.time))).toBe(true)

    // Trend calls sum to the total row count.
    expect(stats.trend.reduce((s, d) => s + d.calls, 0)).toBe(rows.length)
  })
})
