import { describe, it, expect } from 'vitest'

import { applyBuiltinFilter } from '../filter'
import type { OverrideArgs, TemplateBindings } from '../template-loader'

function makeArgs(over: Partial<OverrideArgs> = {}): OverrideArgs {
  return { prompt: 'masterpiece, 1girl', negative: null, seed: 1, ...over }
}
function makeTemplate(seedNegative = 'low quality'): TemplateBindings {
  return { seedNegative } as TemplateBindings
}

describe('applyBuiltinFilter', () => {
  it('rejects when prompt hits a blacklist word (case-insensitive)', () => {
    const args = makeArgs({ prompt: 'a cute NSFW girl' })
    const r = applyBuiltinFilter(args, makeTemplate(), { blacklist: ['nsfw'] })
    expect(typeof r).toBe('string')
    expect(r).toMatch(/nsfw/i)
  })

  it('passes (void) when no blacklist hit', () => {
    const r = applyBuiltinFilter(makeArgs(), makeTemplate(), {
      blacklist: ['nsfw'],
    })
    expect(r).toBeUndefined()
  })

  it('appends forcePositive to prompt', () => {
    const args = makeArgs({ prompt: '1girl' })
    applyBuiltinFilter(args, makeTemplate(), { forcePositive: 'safe, sfw' })
    expect(args.prompt).toBe('1girl, safe, sfw')
  })

  it('forceNegative appends onto template seedNegative when args.negative is null', () => {
    const args = makeArgs({ negative: null })
    applyBuiltinFilter(args, makeTemplate('low quality, blurry'), {
      forceNegative: 'nsfw, nude',
    })
    expect(args.negative).toBe('low quality, blurry, nsfw, nude')
  })

  it('forceNegative appends onto explicit args.negative when given', () => {
    const args = makeArgs({ negative: 'bad hands' })
    applyBuiltinFilter(args, makeTemplate('low quality'), {
      forceNegative: 'nsfw',
    })
    expect(args.negative).toBe('bad hands, nsfw')
  })

  it('blacklist takes precedence: rejects before applying force words', () => {
    const args = makeArgs({ prompt: 'nsfw stuff' })
    const r = applyBuiltinFilter(args, makeTemplate(), {
      blacklist: ['nsfw'],
      forcePositive: 'safe',
    })
    expect(r).toMatch(/nsfw/i)
    expect(args.prompt).toBe('nsfw stuff') // 未被改写
  })

  it('no-op for empty filter', () => {
    const args = makeArgs({ prompt: '1girl', negative: 'x' })
    const r = applyBuiltinFilter(args, makeTemplate(), {})
    expect(r).toBeUndefined()
    expect(args.prompt).toBe('1girl')
    expect(args.negative).toBe('x')
  })
})
