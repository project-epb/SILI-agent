import { describe, expect, it, vi } from 'vitest'

import { fetchImage } from '../user-infobox/image'

const ctxWith = (file: (...args: any[]) => any) => ({ http: { file } }) as any

describe('fetchImage', () => {
  it('inlines the image as a data: URI', async () => {
    const ctx = ctxWith(
      vi.fn().mockResolvedValue({
        type: 'image/png',
        data: new Uint8Array([1, 2, 3]).buffer,
      })
    )
    expect(await fetchImage(ctx, 'https://x/a.png')).toBe(
      'data:image/png;base64,AQID'
    )
  })

  it('returns undefined when the download fails (e.g. 404 for no avatar)', async () => {
    const ctx = ctxWith(vi.fn().mockRejectedValue(new Error('404')))
    expect(await fetchImage(ctx, 'https://x/a.png')).toBeUndefined()
  })

  it('refuses images too large to ride in the page URL', async () => {
    const ctx = ctxWith(
      vi.fn().mockResolvedValue({
        type: 'image/png',
        data: new ArrayBuffer(512 * 1024 + 1),
      })
    )
    expect(await fetchImage(ctx, 'https://x/a.png')).toBeUndefined()
  })
})
