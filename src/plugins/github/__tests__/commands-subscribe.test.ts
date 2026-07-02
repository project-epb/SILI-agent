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
    expect(resolveListReply({ 'b/b': {}, 'a/a': {} })).toBe('a/a\nb/b')
  })
  it('returns the empty message when there are no subscriptions', () => {
    expect(resolveListReply({})).toBe(MSG.listEmpty)
    expect(resolveListReply(undefined)).toBe(MSG.listEmpty)
  })
})

describe('MSG (verbatim from old locale zh-CN.json)', () => {
  it('carries the exact reply strings', () => {
    expect(MSG.listEmpty).toBe('当前没有订阅的仓库。')
    expect(MSG.privateContext).toBe('当前不是群聊上下文。')
    expect(MSG.repoExpected).toBe('请输入仓库名。')
    expect(MSG.repoInvalid).toBe('请输入正确的仓库名。')
    expect(MSG.subAddUnchanged('a/b')).toBe('已经在当前频道订阅过仓库 a/b。')
    expect(MSG.subAddSucceeded).toBe('添加订阅成功！')
    expect(MSG.subDeleteUnchanged('a/b')).toBe('尚未在当前频道订阅过仓库 a/b。')
    expect(MSG.subDeleteSucceeded).toBe('移除订阅成功！')
    expect(MSG.subUnknown('a/b')).toBe('尚未添加过仓库 a/b。发送空行或句号以立即添加并订阅该仓库。')
  })
})
