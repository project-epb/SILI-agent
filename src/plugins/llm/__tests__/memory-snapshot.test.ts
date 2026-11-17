import { describe, expect, it, vi } from 'vitest'

import { buildMemorySnapshot } from '../services/memory-snapshot'

function mkStore(over: { content?: string | null; throws?: Error }) {
  return {
    getMeta: vi.fn(async () => {
      if (over.throws) throw over.throws
      return over.content == null ? null : { content: over.content }
    }),
  }
}

function mkStores(
  priv: { content?: string | null; throws?: Error },
  shared: { content?: string | null; throws?: Error } = {}
) {
  return { private: mkStore(priv), shared: mkStore(shared) }
}

const BOTH = ['private', 'shared'] as const

describe('buildMemorySnapshot', () => {
  it('wraps each record in <user_memory> with owner and tier, inside <long_term_memory>', async () => {
    const stores = mkStores({ content: '- 喜欢热干面' }, { content: '- 在玩原神' })
    const out = await buildMemorySnapshot(stores, 'qq', '123', BOTH, undefined, '小鱼')
    expect(out).toMatch(/^<long_term_memory>/)
    expect(out).toMatch(/<\/long_term_memory>$/)
    expect(out).toContain('<user_memory owner="小鱼" uid="123" tier="private">')
    expect(out).toContain('<user_memory owner="小鱼" uid="123" tier="shared">')
    expect(out).toContain('喜欢热干面')
    expect(out).toContain('在玩原神')
  })

  it('leaves out the private record when only shared is allowed', async () => {
    const stores = mkStores({ content: '- 私密的事' }, { content: '- 公开的事' })
    const out = await buildMemorySnapshot(stores, 'qq', '123', ['shared'])
    expect(out).not.toContain('私密的事')
    expect(out).toContain('公开的事')
    expect(stores.private.getMeta).not.toHaveBeenCalled()
  })

  it('returns empty when no tier is allowed', async () => {
    const stores = mkStores({ content: 'x' }, { content: 'y' })
    expect(await buildMemorySnapshot(stores, 'qq', '1', [])).toBe('')
  })

  it('skips empty records and returns empty when all are empty', async () => {
    const stores = mkStores({ content: '   \n ' }, { content: null })
    expect(await buildMemorySnapshot(stores, 'qq', '1', BOTH)).toBe('')

    const onlyShared = mkStores({ content: '' }, { content: '- x' })
    const out = await buildMemorySnapshot(onlyShared, 'qq', '1', BOTH)
    expect(out).not.toContain('tier="private"')
    expect(out).toContain('tier="shared"')
  })

  it('returns empty and warns when fetch throws', async () => {
    const stores = mkStores({ throws: new Error('db down') })
    const logger = { warn: vi.fn() } as any
    expect(await buildMemorySnapshot(stores, 'qq', '1', BOTH, logger)).toBe('')
    expect(logger.warn).toHaveBeenCalled()
  })

  it('reads each record with the provided platform + userId', async () => {
    const stores = mkStores({ content: 'x' }, { content: 'y' })
    await buildMemorySnapshot(stores, 'qq', '999', BOTH)
    expect(stores.private.getMeta).toHaveBeenCalledWith('qq', '999')
    expect(stores.shared.getMeta).toHaveBeenCalledWith('qq', '999')
  })
})
