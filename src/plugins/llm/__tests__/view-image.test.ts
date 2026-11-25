import { describe, expect, it } from 'vitest'

import { viewImageHandler } from '../tools/view-image'
import { noteImageIds } from '../utils/inbound-images'

const URL = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=abc'
const ref = { id: 'cccccccccccc', sha256: 'c'.repeat(64), type: 'image/webp', width: 1, height: 1 }

function run(images: string[], turnState: Record<string, unknown>) {
  const fetched: string[] = []
  const ctx = { llm: { images: { fetch: async (u: string) => (fetched.push(u), ref) } } }
  const out = viewImageHandler.execute({ images }, { ctx, turnState, logger: { warn() {} } } as any)
  return { out: out as Promise<any>, fetched }
}

describe('view_image', () => {
  it('fetches only URLs that appeared in the conversation', async () => {
    const turnState = {}
    // As read_channel_history returns it: JSON-encoded, entity-escaped.
    noteImageIds(turnState, JSON.stringify({ content: `<img src="${URL.replace('&', '&amp;')}"/>` }))
    const ok = run([URL], turnState)
    expect((await ok.out).images).toEqual([ref.id])
    expect(ok.fetched).toEqual([URL])

    const evil = run(['http://169.254.169.254/latest'], turnState)
    expect((await evil.out).content).toMatch(/^Error/)
    expect(evil.fetched).toEqual([])
  })

  it('caps images per turn', async () => {
    const turnState = {}
    const ids = ['0', '1', '2', '3', '4', '5', '6', '7', '8'].map((c) => c.repeat(12))
    noteImageIds(turnState, ids.map((id) => `<image id="${id}"/>`).join(''))
    expect((await run(ids.slice(0, 4), turnState).out).images).toHaveLength(4)
    expect((await run(ids.slice(4, 8), turnState).out).images).toHaveLength(4)
    expect((await run(ids.slice(8), turnState).out).content).toMatch(/^Error/)
  })
})
