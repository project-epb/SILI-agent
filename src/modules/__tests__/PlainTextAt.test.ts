import { describe, expect, it, vi } from 'vitest'

import PlainTextAt, { afterPlainAt, matchName } from '../PlainTextAt'

// koishi 包顶层会拉 loader 等运行时副作用，在 vitest 下加载失败。
vi.mock('koishi', () => ({
  Context: class {},
  Logger: class {},
  snakeCase: (s: string) => s.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase(),
}))

describe('afterPlainAt', () => {
  it('开头是纯文本 @ 或 ＠ 时返回其后内容', () => {
    expect(afterPlainAt('@SILI Official /usage')).toBe('SILI Official /usage')
    expect(afterPlainAt('  ＠SILI /usage')).toBe('SILI /usage')
  })

  it('不以 @ 开头时不命中', () => {
    expect(afterPlainAt('SILI /usage')).toBeUndefined()
    expect(afterPlainAt('问一下 @SILI')).toBeUndefined()
  })
})

describe('matchName', () => {
  const NAME = 'SILI Official'

  it('完整匹配平台名称，返回其后内容', () => {
    expect(matchName('SILI Official /usage', NAME)).toBe('/usage')
    expect(matchName('SILI Official，usage', NAME)).toBe('usage')
    expect(matchName('SILI Official', NAME)).toBe('')
  })

  it('半截名字、别的 bot 或名字后紧跟字符时不匹配', () => {
    expect(matchName('SILI /usage', NAME)).toBeUndefined()
    expect(matchName('SILI Noir /usage', NAME)).toBeUndefined()
    expect(matchName('SILI Officialx /usage', NAME)).toBeUndefined()
    expect(matchName('SILI Official /usage', '')).toBeUndefined()
  })
})

describe('PlainTextAt.apply', () => {
  const text = (content: string) => ({
    type: 'text',
    attrs: { content },
    toString: () => content,
  })
  const at = (id: string) => ({
    type: 'at',
    attrs: { id },
    toString: () => `<at id="${id}"/>`,
  })
  const run = (content: string | any[], stripped: any) => {
    const session: any = {
      type: 'message-created',
      bot: { user: { name: 'SILI Official' } },
      elements: typeof content === 'string' ? [text(content)] : content,
      stripped,
    }
    PlainTextAt.prototype.apply.call({}, session)
    return stripped
  }

  it('@ 本 bot 的平台名称时算呼叫，content 为其后指令', () => {
    const s = run('@SILI Official /usage', {
      hasAt: false,
      appel: true,
      content: 'Official /usage',
    })
    expect(s).toMatchObject({ appel: true, content: '/usage' })
  })

  it('@ 别的 bot 时撤销 Koishi 的昵称呼叫', () => {
    const s = run('@SILI Noir /usage', {
      hasAt: false,
      appel: true,
      content: 'Noir /usage',
    })
    expect(s).toMatchObject({ appel: false, content: '@SILI Noir /usage' })
  })

  it('@ 普通群友时不动', () => {
    const stripped = { hasAt: false, appel: false, content: '@某人 你好' }
    expect(run('@某人 你好', { ...stripped })).toEqual(stripped)
  })

  it('引用回复开头带原作者的真 @ 时照样识别纯文本 @', () => {
    const s = run([at('author'), text(' @SILI Official /usage')], {
      hasAt: false,
      appel: true,
      content: 'Official /usage',
    })
    expect(s).toMatchObject({ appel: true, content: '/usage' })
  })

  it('真 @ 了别人或本 bot 时不动', () => {
    const other = {
      hasAt: true,
      appel: false,
      content: '@SILI Official /usage',
    }
    expect(
      run([at('x'), text(' @SILI Official /usage')], { ...other })
    ).toEqual(other)
    const self = {
      hasAt: true,
      appel: true,
      atSelf: true,
      content: '@SILI Noir hi',
    }
    expect(run([at('bot'), text(' @SILI Noir hi')], { ...self })).toEqual(self)
  })
})
