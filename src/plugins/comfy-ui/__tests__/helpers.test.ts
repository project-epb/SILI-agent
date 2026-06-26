import { describe, it, expect } from 'vitest'
import { ASPECT_RATIO_MAP } from '../template-loader'
// NOTE: PluginComfyUI.basicAuth is a re-export of this pure helper. We import the
// helper directly because importing the plugin index pulls in koishi's loader,
// whose top-level `require.extensions` side-effect throws under vitest's ESM transform.
import { basicAuth } from '../auth'

describe('ASPECT_RATIO_MAP', () => {
  it('has the 9 NovelAI-style presets with exact dims', () => {
    expect(Object.keys(ASPECT_RATIO_MAP)).toHaveLength(9)
    expect(ASPECT_RATIO_MAP.portrait).toEqual([832, 1216])
    expect(ASPECT_RATIO_MAP.landscape).toEqual([1216, 832])
    expect(ASPECT_RATIO_MAP.square).toEqual([1024, 1024])
    expect(ASPECT_RATIO_MAP.large_square).toEqual([1472, 1472])
    expect(ASPECT_RATIO_MAP.small_landscape).toEqual([768, 512])
  })
})

describe('basicAuth (PluginComfyUI.basicAuth)', () => {
  it('builds an HTTP Basic Authorization header', () => {
    const h = basicAuth('user', 'pass')
    expect(h.Authorization).toBe('Basic ' + Buffer.from('user:pass').toString('base64'))
  })
})
