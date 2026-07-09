import { describe, expect, it } from 'vitest'

import { checkMemoryWrite, utf8ByteLength } from '../memory-edit'

describe('utf8ByteLength', () => {
  it('counts ASCII and multibyte correctly', () => {
    expect(utf8ByteLength('abc')).toBe(3)
    expect(utf8ByteLength('中')).toBe(3) // UTF-8 中文 3 字节
    expect(utf8ByteLength('')).toBe(0)
  })
})

describe('checkMemoryWrite', () => {
  it('accepts content within limit', () => {
    expect(checkMemoryWrite('hello', 3300)).toEqual({ ok: true, byteSize: 5 })
  })
  it('rejects content over the byte limit', () => {
    const r = checkMemoryWrite('中'.repeat(2000), 3300) // 6000 bytes
    expect(r.ok).toBe(false)
    expect(r.byteSize).toBe(6000)
    expect(r.error).toMatch(/超出|limit|字节/)
  })
  it('accepts empty content (clear via save)', () => {
    expect(checkMemoryWrite('', 3300)).toEqual({ ok: true, byteSize: 0 })
  })
})
