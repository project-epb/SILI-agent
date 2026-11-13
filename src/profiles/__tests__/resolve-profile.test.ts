import { describe, expect, it } from 'vitest'

import { DEFAULT_PROFILE, resolveProfileName } from '../index'

describe('resolveProfileName', () => {
  it('falls back to the default profile', () => {
    expect(resolveProfileName([], {})).toBe(DEFAULT_PROFILE)
  })

  it('reads SILI_PROFILE', () => {
    expect(resolveProfileName([], { SILI_PROFILE: 'v4' })).toBe('v4')
  })

  it('prefers --profile over SILI_PROFILE', () => {
    expect(
      resolveProfileName(['bun', 'index.ts', '--profile=v4'], {
        SILI_PROFILE: 'nope',
      })
    ).toBe('v4')
  })

  it('rejects unknown names and lists the available ones', () => {
    expect(() => resolveProfileName([], { SILI_PROFILE: 'v3' })).toThrow(
      /Unknown SILI profile "v3"\. Available: v4/
    )
  })

  it('does not accept inherited object keys as profile names', () => {
    expect(() => resolveProfileName([], { SILI_PROFILE: 'toString' })).toThrow(
      /Unknown SILI profile/
    )
  })
})
