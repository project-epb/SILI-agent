import { describe, expect, it, vi } from 'vitest'

import { fetchAvatar } from '../user-infobox/avatar'

const ctxWith = (file: (...args: any[]) => any) => ({ http: { file } }) as any

describe('fetchAvatar', () => {
  it('inlines the image as a data: URI', async () => {
    const ctx = ctxWith(
      vi.fn().mockResolvedValue({
        type: 'image/png',
        data: new Uint8Array([1, 2, 3]).buffer,
      })
    )
    expect(await fetchAvatar(ctx, 'https://x/a.png')).toBe(
      'data:image/png;base64,AQID'
    )
  })

  it('returns undefined when the download fails (e.g. 404 for no avatar)', async () => {
    const ctx = ctxWith(vi.fn().mockRejectedValue(new Error('404')))
    expect(await fetchAvatar(ctx, 'https://x/a.png')).toBeUndefined()
  })

  it('refuses images too large to ride in the page URL', async () => {
    const ctx = ctxWith(
      vi.fn().mockResolvedValue({
        type: 'image/png',
        data: new ArrayBuffer(2 * 1024 * 1024),
      })
    )
    expect(await fetchAvatar(ctx, 'https://x/a.png')).toBeUndefined()
  })
})
