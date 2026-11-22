import { describe, expect, it } from 'vitest'

import { addTurnSpeaker, pickSpeaker } from '../utils/turn-speakers'

const session = (id: number, name: string) => ({ user: { id, name }, userId: `p${id}`, event: {} }) as any

describe('pickSpeaker', () => {
  it('defaults to the only speaker', () => {
    const state = {}
    const a = session(1, 'A')
    addTurnSpeaker(state, a)
    expect(pickSpeaker(state, a, undefined)).toEqual({ uid: '1', session: a })
  })

  it('requires as_uid once two people spoke, and only accepts one of them', () => {
    const state = {}
    const a = session(1, 'A')
    const b = session(2, 'B')
    addTurnSpeaker(state, a)
    addTurnSpeaker(state, b)
    expect(pickSpeaker(state, a, undefined)).toHaveProperty('error')
    expect(pickSpeaker(state, a, '3')).toHaveProperty('error')
    expect(pickSpeaker(state, a, '2')).toEqual({ uid: '2', session: b })
  })
})
