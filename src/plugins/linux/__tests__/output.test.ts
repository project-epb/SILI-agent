import { describe, expect, it } from 'vitest'

import { HEAD_BYTES, TAIL_BYTES, clipStream, conversationDirName } from '../output'

const bytes = (s: string) => new TextEncoder().encode(s)

describe('clipStream', () => {
  it('keeps a stream that fits whole', () => {
    expect(clipStream(bytes('hello\n'))).toEqual({ text: 'hello\n', omitted: 0 })
  })

  it('keeps the start and the end of a long stream', () => {
    const input = 'A'.repeat(HEAD_BYTES) + 'M'.repeat(1000) + 'Z'.repeat(TAIL_BYTES)
    const out = clipStream(bytes(input))
    expect(out.omitted).toBe(1000)
    expect(out.text.startsWith('A'.repeat(HEAD_BYTES))).toBe(true)
    expect(out.text.endsWith('Z'.repeat(TAIL_BYTES))).toBe(true)
    expect(out.text).not.toContain('M')
  })
})

describe('conversationDirName', () => {
  it('keeps group and private conversations apart', () => {
    expect(conversationDirName('group:qq:ABC123')).toBe('group-qq-ABC123')
    expect(conversationDirName(42)).toBe('user-42')
  })

  it('never yields a path that leaves /workspace', () => {
    expect(conversationDirName('../../etc')).not.toContain('/')
    expect(conversationDirName('../../etc')).not.toContain('..')
  })
})
