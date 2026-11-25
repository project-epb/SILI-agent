import { describe, expect, it } from 'vitest'

import { createProgressNudge } from '../utils/progress-nudge'

describe('createProgressNudge', () => {
  it('nudges after the silence, counts silence again after each nudge or visible text, and stops at the cap', () => {
    let t = 0
    const n = createProgressNudge(
      { afterMs: 60, afterToolCalls: 0, maxPerTurn: 2 },
      () => t
    )
    t = 59
    expect(n.take(1)).toBe(false)
    t = 60
    expect(n.take(1)).toBe(true)
    t = 100
    expect(n.take(1)).toBe(false)
    n.seen()
    t = 150
    expect(n.take(1)).toBe(false)
    t = 160
    expect(n.take(1)).toBe(true)
    t = 1000
    expect(n.take(1)).toBe(false)
  })

  it('nudges after enough quiet tool calls; visible text resets the count', () => {
    const n = createProgressNudge(
      { afterMs: 0, afterToolCalls: 5, maxPerTurn: 9 },
      () => 0
    )
    expect(n.take(3)).toBe(false)
    n.seen()
    expect(n.take(3)).toBe(false)
    expect(n.take(2)).toBe(true)
    expect(n.take(4)).toBe(false)
  })

  it('is off when both triggers are 0', () => {
    let t = 0
    const n = createProgressNudge(
      { afterMs: 0, afterToolCalls: 0, maxPerTurn: 2 },
      () => t
    )
    t = 1e9
    expect(n.take(100)).toBe(false)
  })
})
