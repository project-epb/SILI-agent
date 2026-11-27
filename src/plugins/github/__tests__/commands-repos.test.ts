import { describe, it, expect, vi } from 'vitest'

// koishi 包顶层会拉 loader 等运行时副作用，在 vitest 下加载失败；commands.ts 只在
// applyCommands/applyReposCommand 里用到 Context/Random，被测的纯函数完全不碰它们，全 stub 即可。
vi.mock('koishi', () => ({
  Context: class {},
  Random: { id: () => 'stub-secret' },
}))

import { resolveReposListReply, mapWebhookError, describeHttpError, MSG } from '../commands'

describe('resolveReposListReply', () => {
  it('joins registered repo names by newline', () => {
    expect(resolveReposListReply(['a/a', 'b/b'])).toBe(`${MSG.reposHeader}\na/a\nb/b`)
  })
  it('returns the empty message when none are registered', () => {
    expect(resolveReposListReply([])).toBe(MSG.reposEmpty)
  })
})

describe('mapWebhookError', () => {
  it('maps 404 to notFound', () => {
    expect(mapWebhookError(404)).toBe('notFound')
  })
  it('maps 403 to forbidden', () => {
    expect(mapWebhookError(403)).toBe('forbidden')
  })
  it('maps anything else to failed', () => {
    expect(mapWebhookError(500)).toBe('failed')
    expect(mapWebhookError(undefined)).toBe('failed')
  })
})

describe('describeHttpError', () => {
  it('combines status and upstream message', () => {
    expect(describeHttpError({ response: { status: 422, data: { message: 'Validation Failed' } } }))
      .toBe('HTTP 422: Validation Failed')
  })
  it('falls back to status only when no message', () => {
    expect(describeHttpError({ response: { status: 500 } })).toBe('HTTP 500')
  })
  it('surfaces the network-layer cause code when there is no HTTP response', () => {
    expect(describeHttpError(Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
    }))).toBe('UND_ERR_CONNECT_TIMEOUT')
  })
  it('falls back to the cause message when the cause has no code', () => {
    expect(describeHttpError({ cause: { message: 'connect ETIMEDOUT 140.82.0.0:443' } }))
      .toBe('connect ETIMEDOUT 140.82.0.0:443')
  })
  it('never returns the raw error message (may embed the request URL / secrets)', () => {
    // undici packs the full request URL into .message; returning it would leak query params.
    expect(describeHttpError(new Error('fetch https://github.com/login/oauth/access_token?x=secret failed'))).toBe('')
  })
  it('returns empty string when no status', () => {
    expect(describeHttpError({})).toBe('')
    expect(describeHttpError(new Error('boom'))).toBe('')
  })
})
