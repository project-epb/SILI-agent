import { describe, it, expect } from 'vitest'
import { parseReplyCommand, formatHelp, buildQuotedComment, INDICATOR } from '../reply'

describe('parseReplyCommand', () => {
  it('treats .help / help / !help / /help (any case) as help', () => {
    for (const b of ['.help', 'help', '!help', '/help', 'HELP', '.Help']) {
      expect(parseReplyCommand(b)).toEqual({ name: 'help', message: '' })
    }
  })
  it('dot-prefixed → explicit action name + trailing message', () => {
    expect(parseReplyCommand('.close 修好了')).toEqual({ name: 'close', message: '修好了' })
    expect(parseReplyCommand('.link')).toEqual({ name: 'link', message: '' })
    expect(parseReplyCommand('.merge feat: x')).toEqual({ name: 'merge', message: 'feat: x' })
  })
  it('bare emoji name → react', () => {
    expect(parseReplyCommand('+1')).toEqual({ name: 'react', message: '+1' })
    expect(parseReplyCommand('rocket')).toEqual({ name: 'react', message: 'rocket' })
  })
  it('any other bare text → reply (default)', () => {
    expect(parseReplyCommand('说得好')).toEqual({ name: 'reply', message: '说得好' })
    expect(parseReplyCommand('help我看看')).toEqual({ name: 'reply', message: 'help我看看' })
  })
})

describe('formatHelp', () => {
  it('lists only the supported actions with descriptions', () => {
    const out = formatHelp(['close', 'link', 'react', 'reply'])
    expect(out).toContain('.reply')
    expect(out).toContain('.close')
    expect(out).not.toContain('.merge')
  })
})

describe('buildQuotedComment', () => {
  it('prefixes the quoted original per line, then reply, then INDICATOR + footer', () => {
    const out = buildQuotedComment('alice commented\nbody line', '+1 说得好', 'FOOTER')
    expect(out).toBe('> alice commented\n> body line\n\n+1 说得好\n\n' + INDICATOR + '\nFOOTER')
  })
  it('nested quotes accumulate ( > x → > > x )', () => {
    const out = buildQuotedComment('> earlier', 'ok', '')
    expect(out.split('\n')[0]).toBe('> > earlier')
  })
  it('empty quoted → reply + INDICATOR only', () => {
    expect(buildQuotedComment('', 'hi', '')).toBe('hi\n\n' + INDICATOR)
  })
  it('empty footer → no trailing footer line', () => {
    const out = buildQuotedComment('q', 'r', '')
    expect(out.endsWith(INDICATOR)).toBe(true)
  })
})
