import { describe, it, expect } from 'vitest'
import { cleanBody, issueName } from '../events/util'

describe('cleanBody', () => {
  it('returns empty string for empty/null/undefined', () => {
    expect(cleanBody('', 500)).toBe('')
    expect(cleanBody(null, 500)).toBe('')
    expect(cleanBody(undefined, 500)).toBe('')
  })
  it('drops everything from the bot-message-footer indicator onward', () => {
    expect(cleanBody('hello<!-- BOT-MESSAGE-FOOTER -->world', 500)).toBe('hello')
  })
  it('strips standalone HTML comment lines', () => {
    expect(cleanBody('a\n<!-- hi -->\nb', 500)).toBe('a\nb')
  })
  it('collapses blank lines and trims', () => {
    expect(cleanBody('  a\n\n\n  b  ', 500)).toBe('a\n  b')
  })
  it('preserves blank lines when collapseBlankLines is false (quote-reply body)', () => {
    expect(cleanBody('a\n\nb', 500, false)).toBe('a\n\nb')
  })
  it('truncates longer than maxLength with an ellipsis', () => {
    expect(cleanBody('abcdef', 3)).toBe('abc…')
  })
  it('does not truncate when maxLength is 0', () => {
    expect(cleanBody('abcdef', 0)).toBe('abcdef')
  })
})

describe('issueName', () => {
  it('formats as full_name#number', () => {
    expect(issueName({ full_name: 'org/repo' }, { number: 7 })).toBe('org/repo#7')
  })
})
