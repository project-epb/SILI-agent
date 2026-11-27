import { describe, it, expect, vi } from 'vitest'

// koishi 包顶层会拉 loader 等运行时副作用，在 vitest 下加载失败；commands.ts 只在
// applyCommands/applyReposCommand 里用到 Context/Random，被测的纯函数完全不碰它们，全 stub 即可。
vi.mock('koishi', () => ({
  Context: class {},
  Random: { id: () => 'stub-secret' },
}))

import { REPO_RE, resolveListReply, MSG } from '../commands'

describe('REPO_RE', () => {
  it('accepts owner/repo with word chars, dot, hyphen', () => {
    expect(REPO_RE.test('dragon-fish/sili.bot')).toBe(true)
  })
  it('rejects names without a single slash', () => {
    expect(REPO_RE.test('nope')).toBe(false)
    expect(REPO_RE.test('a/b/c')).toBe(false)
  })
})

describe('resolveListReply', () => {
  it('lists subscribed repo names sorted, one per line', () => {
    expect(resolveListReply({ 'b/b': {}, 'a/a': {} })).toBe(`${MSG.listHeader}\na/a\nb/b`)
  })
  it('returns the empty message when there are no subscriptions', () => {
    expect(resolveListReply({})).toBe(MSG.listEmpty)
    expect(resolveListReply(undefined)).toBe(MSG.listEmpty)
  })
})
