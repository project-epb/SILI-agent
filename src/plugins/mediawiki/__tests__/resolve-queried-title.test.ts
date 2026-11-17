import { describe, expect, it } from 'vitest'

import { resolveQueriedTitle } from '../utils'

describe('resolveQueriedTitle', () => {
  it('跟随名字空间别名规范化', () => {
    const query = { normalized: [{ from: 'T:a', to: 'Template:A' }] }
    expect(resolveQueriedTitle('T:a', query)).toBe('Template:A')
  })

  it('依次跟随 normalized → converted → redirects', () => {
    const query = {
      normalized: [{ from: 'WP:帮助', to: 'Wikipedia:帮助' }],
      converted: [{ from: 'Wikipedia:帮助', to: 'Wikipedia:幫助' }],
      redirects: [{ from: 'Wikipedia:幫助', to: 'Help:首页' }],
    }
    expect(resolveQueriedTitle('WP:帮助', query)).toBe('Help:首页')
  })

  it('没有任何映射时原样返回', () => {
    expect(resolveQueriedTitle('Foo', {})).toBe('Foo')
  })
})
