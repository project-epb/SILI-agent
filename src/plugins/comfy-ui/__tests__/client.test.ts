import { describe, it, expect, vi } from 'vitest'
import { ComfyUIClient, ComfyError } from '../client'

function fakeHttp(handlers: { post?: any; get?: any }): any {
  return {
    post: handlers.post ?? vi.fn(),
    get: handlers.get ?? vi.fn(),
    isError: (e: any) => !!e?.__isHttpError,
  }
}
function httpError(status: number) {
  return { __isHttpError: true, response: { status }, message: `HTTP ${status}` }
}

describe('ComfyUIClient.submit', () => {
  it('returns prompt_id on success', async () => {
    const http = fakeHttp({ post: vi.fn().mockResolvedValue({ prompt_id: 'pid-1' }) })
    const c = new ComfyUIClient(http)
    expect(await c.submit({}, 'cid')).toBe('pid-1')
  })
  it('maps 400 to comfyui_validation', async () => {
    const http = fakeHttp({ post: vi.fn().mockRejectedValue(httpError(400)) })
    await expect(new ComfyUIClient(http).submit({}, 'cid')).rejects.toMatchObject({
      type: 'comfyui_validation',
    })
  })
  it('maps 403 to cf_access', async () => {
    const http = fakeHttp({ post: vi.fn().mockRejectedValue(httpError(403)) })
    await expect(new ComfyUIClient(http).submit({}, 'cid')).rejects.toMatchObject({
      type: 'cf_access',
    })
  })
})

describe('ComfyUIClient.pollUntilDone', () => {
  it('returns the history entry when status success', async () => {
    const get = vi.fn().mockResolvedValue({
      'pid-1': {
        status: { status_str: 'success' },
        outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } },
      },
    })
    const entry = await new ComfyUIClient(fakeHttp({ get })).pollUntilDone('pid-1', 5, 0)
    expect(entry.outputs['9'].images[0].filename).toBe('a.png')
  })
  it('throws comfyui_validation when status_str error', async () => {
    const get = vi.fn().mockResolvedValue({
      'pid-1': { status: { status_str: 'error', messages: [['x', {}]] } },
    })
    await expect(
      new ComfyUIClient(fakeHttp({ get })).pollUntilDone('pid-1', 5, 0)
    ).rejects.toMatchObject({ type: 'comfyui_validation' })
  })
  it('throws timeout when never completes', async () => {
    const get = vi.fn().mockResolvedValue({}) // always no entry
    await expect(
      new ComfyUIClient(fakeHttp({ get })).pollUntilDone('pid-1', 0, 0)
    ).rejects.toMatchObject({ type: 'timeout' })
  })
})

describe('ComfyUIClient.fetchImage', () => {
  it('requests /view with params and returns arraybuffer', async () => {
    const buf = new ArrayBuffer(4)
    const get = vi.fn().mockResolvedValue(buf)
    const c = new ComfyUIClient(fakeHttp({ get }))
    const out = await c.fetchImage({ filename: 'a.png', subfolder: 's', type: 'output' })
    expect(out).toBe(buf)
    expect(get).toHaveBeenCalledWith(
      '/view',
      expect.objectContaining({
        params: { filename: 'a.png', subfolder: 's', type: 'output' },
        responseType: 'arraybuffer',
      })
    )
  })
})
