import { describe, expect, it } from 'vitest'

import { viewImageHandler } from '../tools/view-image'
import { historyImageTags, noteImageIds, turnImages } from '../utils/inbound-images'

const URL = 'https://example.com/a.png'
const ref = (id: string) => ({ id, sha1: id.padEnd(40, '0'), type: 'image/webp', width: 1, height: 1 })

function fakeStore(stored: string[] = []) {
  const fetched: string[] = []
  const store = {
    get: async (id: string) => (stored.includes(id) ? ref(id) : undefined),
    idOfUrl: () => undefined,
    urlOf: () => undefined,
    fetch: async (u: string) => (fetched.push(u), ref('cccccccccccc')),
  }
  return { store, fetched }
}

const call = (images: string[], turnState: any, store: any, iteration = 1) =>
  viewImageHandler.execute({ images }, { ctx: { llm: { images: store } }, turnState, logger: { warn() {} }, iteration } as any) as Promise<any>

const hex = (c: string) => c.repeat(12)

describe('view_image', () => {
  it('fetches only URLs that appeared in the conversation', async () => {
    const turnState = {}
    noteImageIds(turnState, JSON.stringify({ content: `<img src="${URL}"/>` }))
    const { store, fetched } = fakeStore()
    expect((await call([URL], turnState, store)).images).toEqual([hex('c')])
    expect((await call(['http://169.254.169.254/'], turnState, store)).content).toMatch(/^Error/)
    expect(fetched).toEqual([URL])
  })

  it('attaches at most four per batch of calls, and skips images seen before', async () => {
    const ids = ['0', '1', '2', '3', '4', '5'].map(hex)
    const turnState = {}
    noteImageIds(turnState, ids.map((id) => `<image id="${id}"/>`).join(''))
    turnImages(turnState).seen.add(ids[5])
    const { store } = fakeStore(ids)
    expect((await call(ids.slice(0, 3), turnState, store)).images).toHaveLength(3)
    const second = await call(ids.slice(3), turnState, store)
    expect(second.images).toEqual([ids[3]])
    expect(second.content).toContain('per batch')
    expect(second.content).toContain('already viewed')
    expect((await call([ids[4]], turnState, store, 2)).images).toEqual([ids[4]])
  })

  it('says the image expired when it is neither stored nor downloadable', async () => {
    const turnState = {}
    noteImageIds(turnState, `<image id="${hex('9')}"/>`)
    const { store } = fakeStore()
    const out = await call([hex('9')], turnState, store)
    expect(out.images).toEqual([])
    expect(out.content).toContain('expired')
  })
})

describe('historyImageTags', () => {
  it('names hashed URLs by id without downloading and keeps the rest', () => {
    const out = historyImageTags('<img src="a"/>x<img src="b"/>', (u) => (u === 'a' ? hex('a') : undefined))
    expect(out).toBe(`<image id="${hex('a')}"/>x<img src="b"/>`)
  })
})
