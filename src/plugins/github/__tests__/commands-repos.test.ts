import { describe, it, expect, vi } from 'vitest'

// koishi 包顶层会拉 loader 等运行时副作用，在 vitest 下加载失败；commands.ts 只在
// applyCommands/applyReposCommand 里用到 Context/Random，被测的纯函数完全不碰它们，全 stub 即可。
vi.mock('koishi', () => ({
  Context: class {},
  Random: { id: () => 'stub-secret' },
}))

import { resolveReposListReply, mapWebhookError, MSG } from '../commands'

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
  it('maps anything else to failed', () => {
    expect(mapWebhookError(403)).toBe('failed')
    expect(mapWebhookError(500)).toBe('failed')
    expect(mapWebhookError(undefined)).toBe('failed')
  })
})

describe('MSG repos strings (verbatim from old locale)', () => {
  it('exact', () => {
    expect(MSG.reposEmpty).toBe('当前没有监听的仓库。')
    expect(MSG.repoAddUnchanged('a/b')).toBe('已经添加过仓库 a/b。')
    expect(MSG.repoAddSucceeded).toBe('添加仓库成功！')
    expect(MSG.repoAddFailed).toBe('由于未知原因添加仓库失败。')
    expect(MSG.repoNotFound).toBe('仓库不存在或您无权访问。')
    expect(MSG.repoDeleteUnchanged('a/b')).toBe('尚未添加过仓库 a/b。')
    expect(MSG.repoDeleteSucceeded).toBe('移除仓库成功！')
  })
})
