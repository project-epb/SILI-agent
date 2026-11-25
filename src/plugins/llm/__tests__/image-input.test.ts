import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { splitImages, withToolAttachments } from '../providers/images'
import { ResponsesProvider } from '../providers/responses'
import { ImageStore, attachedImages, imageTag } from '../services/image-store'

const A = 'aaaaaaaaaaaa'
const B = 'bbbbbbbbbbbb'
const tag = (id: string) => `<image id="${id}" type="image/webp" width="1" height="1"/>`

describe('splitImages', () => {
  it('puts each image right after its tag, untagged ones at the end', () => {
    expect(splitImages(`x${tag(A)}y`, [A, B])).toEqual([
      { type: 'text', text: `x${tag(A)}` },
      { type: 'image', id: A },
      { type: 'text', text: 'y' },
      { type: 'image', id: B },
    ])
  })
})

describe('withToolAttachments', () => {
  it('moves tool images into one user message after the batch', () => {
    const out = withToolAttachments([
      { role: 'assistant', content: '', tool_calls: [] },
      { role: 'tool', tool_call_id: 'c1', tool_name: 'view_image', content: 'ok', images: [A] },
      { role: 'tool', tool_call_id: 'c2', tool_name: 'x', content: 'ok' },
      { role: 'assistant', content: 'done' },
    ])
    expect(out.map((m) => m.role)).toEqual(['assistant', 'tool', 'tool', 'user', 'assistant'])
    const user = out[3] as any
    expect(user.images).toEqual([A])
    expect(user.content).toContain(`call_id="c1" image="${A}"`)
  })
})

describe('attachedImages', () => {
  it('attaches the first four distinct images and notes the rest', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'].map((c) => c.repeat(12))
    const r = attachedImages(ids.map(tag).join('') + tag(ids[0]))
    expect(r.ids).toEqual(ids.slice(0, 4))
    expect(r.note).toContain('共 5 张')
  })
})

describe('ImageStore', () => {
  const make = async (maxBytes = 1e9, ttlMs = 1e9) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'imgs-'))
    let encodes = 0
    const store = new ImageStore({
      dir,
      ttlMs,
      maxBytes,
      maxImageBytes: 100,
      encode: async (bytes) => (encodes++, { bytes: new Uint8Array(10).fill(bytes[0]), width: 2, height: 3 }),
      fetch: async () => new Uint8Array([9]),
    })
    return { dir, store, encodes: () => encodes }
  }

  it('stores identical bytes once and reads them back', async () => {
    const { store, encodes } = await make()
    const a = await store.put(new Uint8Array([1, 2]))
    const b = await store.put(new Uint8Array([1, 2]))
    expect(b).toEqual(a)
    expect(encodes()).toBe(1)
    expect(imageTag(a)).toBe(`<image id="${a.id}" type="image/webp" width="2" height="3"/>`)
    expect((await store.read(a.id))?.bytes.length).toBe(10)
    await expect(store.put(new Uint8Array(101))).rejects.toThrow()
  })

  it('evicts the least recently used past the size cap', async () => {
    const { store, dir } = await make(25)
    const a = await store.put(new Uint8Array([1]))
    const b = await store.put(new Uint8Array([2]))
    const c = await store.put(new Uint8Array([3]))
    const old = new Date(Date.now() - 60_000)
    await fs.utimes(path.join(dir, `${b.sha256}.2x3.webp`), old, old)
    const r = await store.cleanup()
    expect(r.removed).toBe(1)
    expect(await store.get(b.id)).toBeUndefined()
    expect(await store.get(a.id)).toBeDefined()
    expect(await store.get(c.id)).toBeDefined()
  })
})

describe('ResponsesProvider.toInput', () => {
  it('replays reasoning before the function calls it led to', async () => {
    const p = new ResponsesProvider({ apiKey: 'x' })
    const input = await p.toInput([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'think',
        tool_calls: [{ id: 'c1', name: 'f', arguments: { a: 1 } }],
      },
      { role: 'tool', tool_call_id: 'c1', tool_name: 'f', content: 'r' },
    ])
    expect(input.map((i) => i.type ?? i.role)).toEqual(['user', 'reasoning', 'function_call', 'function_call_output'])
    expect(input[1].content[0]).toEqual({ type: 'reasoning_text', text: 'think' })
  })

  it('turns images into a note without vision', async () => {
    const p = new ResponsesProvider({ apiKey: 'x' })
    const [msg] = await p.toInput([{ role: 'user', content: tag(A), images: [A] }])
    expect(msg.content).toEqual([{ type: 'input_text', text: expect.stringContaining('看不到图片') }])
  })
})
