import { describe, it, expect } from 'vitest'

import { DSML_LEAK_PATTERN, containsDsmlLeak } from '../utils/dsml-leak'

describe('containsDsmlLeak', () => {
  it('detects the single-pipe variant <｜DSML｜tool_calls>', () => {
    const leaked = '着萌娘百科～\n\n<｜DSML｜tool_calls>\n<｜DSML｜invoke name="execute_koishi_command">'
    expect(containsDsmlLeak(leaked)).toBe(true)
  })

  it('detects the doubled-pipe variant <｜｜DSML｜｜tool_calls>', () => {
    const leaked = '再试一次～\n\n<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="execute_koishi_command">'
    expect(containsDsmlLeak(leaked)).toBe(true)
  })

  it('detects as soon as the opening signature streams in (no closing > needed)', () => {
    // Fires at "<｜DSML" before the tool-call body arrives, so the loop can
    // bail early instead of streaming the whole garbage block.
    expect(containsDsmlLeak('<｜DSML')).toBe(true)
    expect(containsDsmlLeak('<｜｜DSML')).toBe(true)
  })

  it('does NOT match bare ASCII "DSML" embedded in base64 tool output', () => {
    // Real production false-positive case: a base64 image blob in a
    // role=tool row that happens to contain the substring "DSML".
    const base64 = 'AIQhACtU9LDSMLIIY4WlxcWxtDQSep5eKuoU3exN3awIQhQQCEIQAhCEAIQhACEIQAhCEA'
    expect(containsDsmlLeak(base64)).toBe(false)
  })

  it('does NOT match a full-width pipe SEPARATOR before the DSML acronym', () => {
    // Anchoring on a leading `<` rules out prose that uses `｜` as a divider:
    // `软件工程｜DSML建模` is legit text, not the leak token.
    expect(containsDsmlLeak('软件工程｜DSML建模语言')).toBe(false)
  })

  it('does NOT match ASCII pipe + DSML (only full-width pipe is the token)', () => {
    expect(containsDsmlLeak('<|DSML|>')).toBe(false)
  })

  it('does NOT match normal prose mentioning DSML', () => {
    expect(containsDsmlLeak('帮我查一下萌娘百科上的 DSML 这个词是什么意思')).toBe(false)
  })

  it('pattern is stateless (no global flag) — repeated calls are consistent', () => {
    const leaked = '<｜DSML｜tool_calls>'
    expect(containsDsmlLeak(leaked)).toBe(true)
    expect(containsDsmlLeak(leaked)).toBe(true)
    expect(DSML_LEAK_PATTERN.global).toBe(false)
  })
})
