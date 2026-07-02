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
    expect(resolveReposListReply(['a/a', 'b/b'])).toBe('a/a\nb/b')
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
  it('returns empty string when no status', () => {
    expect(describeHttpError({})).toBe('')
    expect(describeHttpError(new Error('boom'))).toBe('')
  })
})

describe('MSG repos strings (verbatim from old locale)', () => {
  it('exact', () => {
    expect(MSG.reposEmpty).toBe('当前没有监听的仓库。')
    expect(MSG.repoAddUnchanged('a/b')).toBe('已经添加过仓库 a/b。')
    expect(MSG.repoAddSucceeded).toBe('添加仓库成功！')
    expect(MSG.repoAddFailed).toBe('由于未知原因添加仓库失败。')
    expect(MSG.repoNotFound).toBe('仓库不存在或您无权访问。')
    expect(MSG.forbidden).toBe('第三方访问受限，请尝试授权此应用。\nhttps://docs.github.com/articles/restricting-access-to-your-organization-s-data/')
    expect(MSG.repoDeleteUnchanged('a/b')).toBe('尚未添加过仓库 a/b。')
    expect(MSG.repoDeleteSucceeded).toBe('移除仓库成功！')
    expect(MSG.repoDeleteFailed).toBe('由于未知原因移除仓库失败。')
  })
})
