import { describe, expect, it } from 'vitest'

import { parseStopKeyword } from '../utils/stop-keyword'

describe('parseStopKeyword', () => {
  it('reads a bare stop word as a stop with no rest', () => {
    expect(parseStopKeyword('停')).toBe('')
    expect(parseStopKeyword('  闭嘴！')).toBe('')
    expect(parseStopKeyword('STOP')).toBe('')
  })

  it('keeps what follows the stop word', () => {
    expect(parseStopKeyword('停，改用 Python')).toBe('改用 Python')
    expect(parseStopKeyword('停止 先别装了')).toBe('先别装了')
    expect(parseStopKeyword('stop. use bash')).toBe('use bash')
  })

  it('does not stop on words that merely start with a stop word', () => {
    expect(parseStopKeyword('停车场怎么走')).toBeNull()
    expect(parseStopKeyword('stopwatch 怎么用')).toBeNull()
    expect(parseStopKeyword('帮我停一下服务')).toBeNull()
  })

  it('takes the longest word, not a prefix of it', () => {
    expect(parseStopKeyword('停止')).toBe('')
  })
})
