import { describe, expect, it } from 'bun:test'
import { h } from 'koishi'

import { passiveFallback } from '../index'

function run(used: number, content: string, platform = 'qq') {
  const source: any = { platform, messageId: 'm1', qq: { id: 'e1' }, seq: used }
  const options: any = { session: source }
  passiveFallback({ elements: h.parse(content) } as any, options)
  return { source, sent: options.session }
}

describe('passiveFallback', () => {
  it('keeps a reply that fits as passive', () => {
    const { source, sent } = run(4, 'hello')
    expect(sent).toBe(source)
  })

  it('sends the sixth reply proactively', () => {
    const { source, sent } = run(5, 'hello')
    expect(sent).not.toBe(source)
    expect(sent.messageId).toBeUndefined()
    expect(sent.qq).toBeUndefined()
    expect(source.messageId).toBe('m1')
  })

  it('counts each media element as its own send', () => {
    expect(run(3, '<img src="a"/>text').sent.messageId).toBe('m1')
    expect(run(4, '<img src="a"/>text').sent.messageId).toBeUndefined()
  })

  it('leaves other platforms alone', () => {
    expect(run(9, 'hello', 'onebot').sent.messageId).toBe('m1')
  })
})
