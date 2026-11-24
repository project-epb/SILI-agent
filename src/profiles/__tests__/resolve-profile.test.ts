import { describe, expect, it } from 'vitest'

import { resolveProfileName } from '../index'

describe('resolveProfileName', () => {
  it('falls back to the default profile', () => {
    expect(resolveProfileName([], {})).toBe('v5')
  })

  it('reads SILI_PROFILE', () => {
    expect(resolveProfileName([], { SILI_PROFILE: 'v5' })).toBe('v5')
  })

  it('prefers --profile over SILI_PROFILE', () => {
    expect(
      resolveProfileName(['bun', 'index.ts', '--profile=v5'], {
        SILI_PROFILE: 'nope',
      })
    ).toBe('v5')
  })

  it('rejects unknown names and lists the available ones', () => {
    expect(() => resolveProfileName([], { SILI_PROFILE: 'v3' })).toThrow(
      /Unknown SILI profile "v3"\. Available: v5/
    )
  })

  it('rejects the retired v4 profile', () => {
    expect(() => resolveProfileName([], { SILI_PROFILE: 'v4' })).toThrow(
      /Unknown SILI profile "v4"/
    )
  })

  it('does not accept inherited object keys as profile names', () => {
    expect(() => resolveProfileName([], { SILI_PROFILE: 'toString' })).toThrow(
      /Unknown SILI profile/
    )
  })
})
