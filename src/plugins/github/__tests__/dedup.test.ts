import { describe, it, expect, vi } from 'vitest'
import { DedupStore } from '../dedup'

function makeCtx() {
  return { setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms) } as any
}

describe('DedupStore', () => {
  it('firstSeen returns true once per id, false on repeats', () => {
    const d = new DedupStore(makeCtx(), 1000)
    expect(d.firstSeen('d1')).toBe(true)
    expect(d.firstSeen('d1')).toBe(false)
    expect(d.firstSeen('d2')).toBe(true)
  })
  it('never dedups an empty id (missing delivery id must still process)', () => {
    const d = new DedupStore(makeCtx(), 1000)
    expect(d.firstSeen('')).toBe(true)
    expect(d.firstSeen('')).toBe(true)
  })
  it('forgets an id after the ttl so a much-later redelivery processes again', async () => {
    vi.useFakeTimers()
    try {
      const d = new DedupStore(makeCtx(), 1000)
      expect(d.firstSeen('d1')).toBe(true)
      expect(d.firstSeen('d1')).toBe(false)
      await vi.advanceTimersByTimeAsync(1001)
      expect(d.firstSeen('d1')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
