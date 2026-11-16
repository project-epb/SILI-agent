import { describe, expect, it } from 'vitest'
import { passiveFallback } from '../passive'

function run(used: number, types: string[], platform = 'qq') {
  const source: any = { platform, messageId: 'm1', qq: { id: 'e1' }, seq: used }
  const options: any = { session: source }
  passiveFallback({ elements: types.map((type) => ({ type })) }, options)
  return { source, sent: options.session }
}

describe('passiveFallback', () => {
  it('keeps a reply that fits as passive', () => {
    const { source, sent } = run(4, ['text'])
    expect(sent).toBe(source)
  })

  it('sends the sixth reply proactively', () => {
    const { source, sent } = run(5, ['text'])
    expect(sent).not.toBe(source)
    expect(sent.messageId).toBeUndefined()
    expect(sent.qq).toBeUndefined()
    expect(source.messageId).toBe('m1')
  })

  it('counts each media element as its own send', () => {
    expect(run(3, ['img', 'text']).sent.messageId).toBe('m1')
    expect(run(4, ['img', 'text']).sent.messageId).toBeUndefined()
  })

  it('leaves other platforms alone', () => {
    expect(run(9, ['text'], 'onebot').sent.messageId).toBe('m1')
  })
})
