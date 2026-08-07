import { describe, it, expect, vi } from 'vitest'
import { HistoryStore, HISTORY_TABLE } from '../history'

const HOT = 1000
const COLD = 10000

/** Minimal stand-in for the koishi database calls HistoryStore makes. */
function makeDb(rows: any[] = []) {
  return {
    get: vi.fn(async () => rows),
    upsert: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  }
}

function makeCtx(database: any = makeDb()) {
  return {
    setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
    database,
    logger: () => ({ warn: () => {} }),
  } as any
}

const entry = { actions: { link: ['x'] }, body: 'b' }

describe('HistoryStore hot layer (memory)', () => {
  it('records actions + body under every message id and reads them back', () => {
    const store = new HistoryStore(makeCtx(), HOT, COLD)
    store.record(['m1', 'm2'], { link: ['x'] }, 'quoted body')
    expect(store.get('m1')).toEqual({ actions: { link: ['x'] }, body: 'quoted body' })
    expect(store.get('m2')).toEqual({ actions: { link: ['x'] }, body: 'quoted body' })
    expect(store.get('m3')).toBeUndefined()
  })

  it('ignores empty message ids or empty actions', () => {
    const store = new HistoryStore(makeCtx(), HOT, COLD)
    store.record([], { link: ['x'] }, 'b')
    store.record(['m'], {}, 'b')
    expect(store.get('m')).toBeUndefined()
  })

  it('expires entries from memory after the hot ttl', async () => {
    vi.useFakeTimers()
    try {
      const store = new HistoryStore(makeCtx(), HOT, COLD)
      store.record(['m'], { link: ['x'] }, 'b')
      expect(store.get('m')).toEqual(entry)
      await vi.advanceTimersByTimeAsync(HOT + 1)
      expect(store.get('m')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('memory expiry leaves the cold row alone — the two layers expire independently', async () => {
    vi.useFakeTimers()
    try {
      const db = makeDb()
      const store = new HistoryStore(makeCtx(db), HOT, COLD)
      store.record(['m'], { link: ['x'] }, 'b')
      await vi.advanceTimersByTimeAsync(HOT + 1)
      expect(store.get('m')).toBeUndefined()
      expect(db.remove).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('HistoryStore cold layer (database)', () => {
  it('writes one row per message id, expiring at now + cold ttl', async () => {
    const db = makeDb()
    const store = new HistoryStore(makeCtx(db), HOT, COLD)
    const before = Date.now()
    store.record(['m1', 'm2'], { link: ['x'] }, 'b')
    await vi.waitFor(() => expect(db.upsert).toHaveBeenCalled())
    const [table, rows] = db.upsert.mock.calls[0] as any
    expect(table).toBe(HISTORY_TABLE)
    expect(rows.map((r: any) => r.messageId)).toEqual(['m1', 'm2'])
    expect(rows[0]).toMatchObject({ actions: { link: ['x'] }, body: 'b' })
    expect(+rows[0].expireAt).toBeGreaterThanOrEqual(before + COLD)
  })

  it('keeps serving from memory when the database write fails', async () => {
    // Persistence is an enhancement: a broken database must never cost us a quick reply.
    const db = makeDb()
    db.upsert.mockRejectedValue(new Error('mongo down'))
    const store = new HistoryStore(makeCtx(db), HOT, COLD)
    store.record(['m'], { link: ['x'] }, 'b')
    expect(store.get('m')).toEqual(entry)
    await vi.waitFor(() => expect(db.upsert).toHaveBeenCalled())
  })

  it('fetch() serves a hot entry without touching the database', async () => {
    const db = makeDb()
    const store = new HistoryStore(makeCtx(db), HOT, COLD)
    store.record(['m'], { link: ['x'] }, 'b')
    expect(await store.fetch('m')).toEqual(entry)
    expect(db.get).not.toHaveBeenCalled()
  })

  it('fetch() falls back to the cold row and warms it back into memory', async () => {
    const db = makeDb([
      { messageId: 'm', actions: { link: ['x'] }, body: 'b', expireAt: new Date(Date.now() + COLD) },
    ])
    const store = new HistoryStore(makeCtx(db), HOT, COLD)
    expect(store.get('m')).toBeUndefined() // cold: not in memory yet
    expect(await store.fetch('m')).toEqual(entry)
    expect(store.get('m')).toEqual(entry) // warmed — a second quote skips the database
  })

  it('fetch() ignores a row past its cold deadline', async () => {
    const db = makeDb([
      { messageId: 'm', actions: { link: ['x'] }, body: 'b', expireAt: new Date(Date.now() - 1) },
    ])
    const store = new HistoryStore(makeCtx(db), HOT, COLD)
    expect(await store.fetch('m')).toBeUndefined()
    expect(store.get('m')).toBeUndefined()
  })

  it('fetch() returns undefined for a message that was never recorded', async () => {
    const store = new HistoryStore(makeCtx(makeDb([])), HOT, COLD)
    expect(await store.fetch('nope')).toBeUndefined()
  })

  it('a warmed entry expires from memory after the hot ttl', async () => {
    vi.useFakeTimers()
    try {
      const db = makeDb([
        { messageId: 'm', actions: { link: ['x'] }, body: 'b', expireAt: new Date(Date.now() + COLD) },
      ])
      const store = new HistoryStore(makeCtx(db), HOT, COLD)
      await store.fetch('m')
      expect(store.get('m')).toEqual(entry)
      await vi.advanceTimersByTimeAsync(HOT + 1)
      expect(store.get('m')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a warmed entry never outlives its cold deadline', async () => {
    vi.useFakeTimers()
    try {
      // Only 200ms of cold life left — shorter than the 1000ms hot ttl.
      const db = makeDb([
        { messageId: 'm', actions: { link: ['x'] }, body: 'b', expireAt: new Date(Date.now() + 200) },
      ])
      const store = new HistoryStore(makeCtx(db), HOT, COLD)
      await store.fetch('m')
      await vi.advanceTimersByTimeAsync(201)
      expect(store.get('m')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fetch() returns undefined when the database is down', async () => {
    const db = makeDb()
    db.get.mockRejectedValue(new Error('mongo down'))
    const store = new HistoryStore(makeCtx(db), HOT, COLD)
    await expect(store.fetch('m')).resolves.toBeUndefined()
  })

  it('prune() deletes rows past their cold deadline', async () => {
    const db = makeDb()
    const store = new HistoryStore(makeCtx(db), HOT, COLD)
    await store.prune()
    // Cleanup rides on startup — no cron, no sweep interval.
    expect(db.remove).toHaveBeenCalledWith(HISTORY_TABLE, {
      expireAt: { $lte: expect.any(Date) },
    })
  })

  it('prune() survives a database that is down', async () => {
    const db = makeDb()
    db.remove.mockRejectedValue(new Error('mongo down'))
    const store = new HistoryStore(makeCtx(db), HOT, COLD)
    await expect(store.prune()).resolves.toBeUndefined()
  })
})
