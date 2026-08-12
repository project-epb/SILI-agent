import { describe, it, expect } from 'vitest'
import { cleanBody, escapeMarkup, issueName } from '../events/util'

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

describe('escapeMarkup', () => {
  it('escapes the characters koishi would parse as element source', () => {
    expect(escapeMarkup('<img src="x"/>')).toBe('&lt;img src="x"/&gt;')
  })

  it('escapes & first so entities are not double-escaped', () => {
    expect(escapeMarkup('a & <b>')).toBe('a &amp; &lt;b&gt;')
    expect(escapeMarkup('&lt;')).toBe('&amp;lt;')
  })

  it('leaves quotes alone — message bodies are not attribute values', () => {
    expect(escapeMarkup('say "hi"')).toBe('say "hi"')
  })

  it('leaves ordinary text untouched', () => {
    expect(escapeMarkup('just text')).toBe('just text')
  })
})
