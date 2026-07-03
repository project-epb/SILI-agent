import { describe, it, expect, vi } from 'vitest'

// The koishi barrel pulls in loader side-effects that fail under vitest
// (see subscribe.test.ts). subscribe.ts only needs `camelize`, so stub the
// module with a faithful copy of cosmokit's impl.
vi.mock('koishi', () => ({
  camelize: (source: string) =>
    source.replace(/[_-][a-z]/g, (str) => str.slice(1).toUpperCase()),
}))

import { migrateRepoRename } from '../rename'
import { SubscriptionStore } from '../subscribe'

describe('migrateRepoRename', () => {
  it('renames the hook row, re-keys each channel webhooks map, and swaps the store index', async () => {
    const store = new SubscriptionStore()
    store.subscribe('old/name', 'qq:1', { push: true })
    store.subscribe('old/name', 'qq:2', {})

    const channels = [
      { id: '1', platform: 'qq', github: { webhooks: { 'old/name': { push: true }, 'x/y': {} } } },
      { id: '2', platform: 'qq', github: { webhooks: { 'old/name': {} } } },
      { id: '3', platform: 'qq', github: { webhooks: { 'z/z': {} } } }, // unrelated, untouched
    ]
    const deps = {
      setHookName: vi.fn().mockResolvedValue(undefined),
      getChannels: vi.fn().mockResolvedValue(channels),
      upsertChannels: vi.fn().mockResolvedValue(undefined),
    }

    await migrateRepoRename(999, 'old/name', 'new/name', 'sek', store, deps)

    // hook row updated (keep secret)
    expect(deps.setHookName).toHaveBeenCalledWith(999, 'new/name', 'sek')
    // only the two channels that had old/name are upserted, re-keyed to new/name
    const upserted = deps.upsertChannels.mock.calls[0][0]
    expect(upserted.map((c: any) => c.id).sort()).toEqual(['1', '2'])
    expect(upserted.find((c: any) => c.id === '1').github.webhooks).toEqual({ 'new/name': { push: true }, 'x/y': {} })
    expect(upserted.find((c: any) => c.id === '2').github.webhooks).toEqual({ 'new/name': {} })
    // store: old gone, new present with per-channel meta preserved
    expect(store.targets('old/name', 'push')).toEqual([])
    expect(store.targets('new/name', 'push').sort()).toEqual(['qq:1', 'qq:2'])
  })
})
