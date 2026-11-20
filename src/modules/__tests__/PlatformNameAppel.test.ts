import { describe, expect, it, vi } from 'vitest'

import { matchLeadingName } from '../PlatformNameAppel'

// koishi 包顶层会拉 loader 等运行时副作用，在 vitest 下加载失败。
vi.mock('koishi', () => ({
  Context: class {},
  Logger: class {},
  snakeCase: (s: string) => s.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase(),
}))

const NAME = 'SILI Official'

describe('matchLeadingName', () => {
  it('匹配开头的纯文本 @ 全名，返回其后内容', () => {
    expect(matchLeadingName('@SILI Official /usage ', NAME)).toBe('/usage ')
    expect(matchLeadingName(' @SILI Official /usage', NAME)).toBe('/usage')
  })

  it('支持全角 ＠ 和不带 @ 的全名', () => {
    expect(matchLeadingName('＠SILI Official /usage', NAME)).toBe('/usage')
    expect(matchLeadingName('SILI Official /usage', NAME)).toBe('/usage')
  })

  it('名字后可以跟逗号', () => {
    expect(matchLeadingName('SILI Official，usage', NAME)).toBe('usage')
  })

  it('只有全名时返回空串', () => {
    expect(matchLeadingName('@SILI Official', NAME)).toBe('')
  })

  it('名字后紧跟其他字符时不匹配', () => {
    expect(matchLeadingName('@SILI Officialx /usage', NAME)).toBeUndefined()
  })

  it('只有半截名字时不匹配', () => {
    expect(matchLeadingName('@SILI /usage', NAME)).toBeUndefined()
  })

  it('名字为空时不匹配', () => {
    expect(matchLeadingName('@ /usage', '')).toBeUndefined()
  })
})
