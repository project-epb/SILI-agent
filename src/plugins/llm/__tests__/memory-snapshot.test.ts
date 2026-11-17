import { describe, expect, it, vi } from 'vitest'

import { type MemoryTier, readableTiers, snapshotTiers } from '../tools/read-user-memory'
import { type MemorySnapshotSource, buildMemorySnapshot } from '../services/memory-snapshot'

function src(
  tier: MemoryTier,
  content: string | null,
  owner = { name: '小鱼', uid: '123' }
): MemorySnapshotSource & { read: ReturnType<typeof vi.fn> } {
  return {
    tier,
    owner,
    read: vi.fn(async () => (content == null ? null : { content })),
  }
}

describe('buildMemorySnapshot', () => {
  it('wraps each record in <user_memory> with owner and tier, inside <long_term_memory>', async () => {
    const out = await buildMemorySnapshot([
      src('private', '- 喜欢热干面'),
      src('shared', '- 在玩原神'),
    ])
    expect(out).toMatch(/^<long_term_memory>/)
    expect(out).toMatch(/<\/long_term_memory>$/)
    expect(out).toContain('<user_memory owner="小鱼" uid="123" tier="private">')
    expect(out).toContain('<user_memory owner="小鱼" uid="123" tier="shared">')
    expect(out).toContain('喜欢热干面')
    expect(out).toContain('在玩原神')
  })

  it('labels a group memory with the group as its owner', async () => {
    const out = await buildMemorySnapshot([
      src('group', '- 群梗：允许叔叔的🐴复活', { name: '测试群', uid: 'G1' }),
    ])
    expect(out).toContain('<user_memory owner="测试群" uid="G1" tier="group">')
  })

  it('returns empty for no sources', async () => {
    expect(await buildMemorySnapshot([])).toBe('')
  })

  it('skips empty records and returns empty when all are empty', async () => {
    expect(
      await buildMemorySnapshot([src('private', '   \n '), src('shared', null)])
    ).toBe('')

    const out = await buildMemorySnapshot([src('private', ''), src('shared', '- x')])
    expect(out).not.toContain('tier="private"')
    expect(out).toContain('tier="shared"')
  })

  it('returns empty and warns when a read throws', async () => {
    const failing = src('private', 'x')
    failing.read.mockRejectedValue(new Error('db down'))
    const logger = { warn: vi.fn() } as any
    expect(await buildMemorySnapshot([failing], logger)).toBe('')
    expect(logger.warn).toHaveBeenCalled()
  })
})

describe('memory tier gating', () => {
  it('reads the private record only in a DM, the group memory only in a group', () => {
    expect(readableTiers(true)).toEqual(['private', 'shared'])
    expect(readableTiers(false)).toEqual(['shared', 'group'])
  })

  it("seeds a group's shared conversation with the group memory only", () => {
    expect(snapshotTiers(false, true)).toEqual(['group'])
    expect(snapshotTiers(true, false)).toEqual(['private', 'shared'])
  })
})
