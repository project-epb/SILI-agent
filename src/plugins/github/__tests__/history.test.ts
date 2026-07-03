import { describe, it, expect, vi } from 'vitest'
import { HistoryStore } from '../history'

function makeCtx() {
  return { setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms) } as any
}

describe('HistoryStore', () => {
  it('records actions + body under every message id and reads them back', () => {
    const store = new HistoryStore(makeCtx(), 1000)
    store.record(['m1', 'm2'], { link: ['x'] }, 'quoted body')
    expect(store.get('m1')).toEqual({ actions: { link: ['x'] }, body: 'quoted body' })
    expect(store.get('m2')).toEqual({ actions: { link: ['x'] }, body: 'quoted body' })
    expect(store.get('m3')).toBeUndefined()
  })

  it('ignores empty message ids or empty actions', () => {
    const store = new HistoryStore(makeCtx(), 1000)
    store.record([], { link: ['x'] }, 'b')
    store.record(['m'], {}, 'b')
    expect(store.get('m')).toBeUndefined()
  })

  it('expires entries after the ttl', async () => {
    vi.useFakeTimers()
    try {
      const store = new HistoryStore(makeCtx(), 1000)
      store.record(['m'], { link: ['x'] }, 'b')
      expect(store.get('m')).toEqual({ actions: { link: ['x'] }, body: 'b' })
      await vi.advanceTimersByTimeAsync(1001)
      expect(store.get('m')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
