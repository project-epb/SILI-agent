import { describe, expect, it } from 'vitest'

import { createProgressNudge } from '../utils/progress-nudge'

describe('createProgressNudge', () => {
  it('nudges after the silence, counts silence again after each nudge or visible text, and stops at the cap', () => {
    let t = 0
    const n = createProgressNudge({ afterMs: 60, maxPerTurn: 2 }, () => t)
    t = 59
    expect(n.take()).toBe(false)
    t = 60
    expect(n.take()).toBe(true)
    t = 100
    expect(n.take()).toBe(false)
    n.seen()
    t = 150
    expect(n.take()).toBe(false)
    t = 160
    expect(n.take()).toBe(true)
    t = 1000
    expect(n.take()).toBe(false)
  })

  it('is off at 0', () => {
    let t = 0
    const n = createProgressNudge({ afterMs: 0, maxPerTurn: 2 }, () => t)
    t = 1e9
    expect(n.take()).toBe(false)
  })
})
