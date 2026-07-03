import { describe, it, expect, vi } from 'vitest'

// The koishi barrel pulls in loader side-effects that fail under vitest
// (see src/plugins/__tests__/repeater.test.ts). subscribe.ts only needs
// `camelize`, so stub the module with a faithful copy of cosmokit's impl.
vi.mock('koishi', () => ({
  camelize: (source: string) =>
    source.replace(/[_-][a-z]/g, (str) => str.slice(1).toUpperCase()),
}))

import { filterTargets, SubscriptionStore } from '../subscribe'

describe('filterTargets', () => {
  it('includes a channel with empty meta (no filters)', () => {
    expect(filterTargets({ 'mock:1': {} }, 'push')).toEqual(['mock:1'])
  })
  it('excludes a channel that disabled the event', () => {
    expect(filterTargets({ 'mock:1': { push: false } }, 'push')).toEqual([])
  })
  it('excludes a channel that disabled the specific action', () => {
    expect(filterTargets({ 'mock:1': { issues: { opened: false } } }, 'issues', 'opened')).toEqual([])
  })
  it('includes when a different action is disabled', () => {
    expect(filterTargets({ 'mock:1': { issues: { closed: false } } }, 'issues', 'opened')).toEqual(['mock:1'])
  })
  it('camelizes hyphenated/underscored events', () => {
    expect(filterTargets({ 'mock:1': { pullRequest: false } }, 'pull_request', 'opened')).toEqual([])
  })
  it('event===true includes regardless of action', () => {
    expect(filterTargets({ 'mock:1': { issues: true } }, 'issues', 'closed')).toEqual(['mock:1'])
  })
})

describe('SubscriptionStore', () => {
  it('subscribes and resolves targets', () => {
    const s = new SubscriptionStore()
    s.subscribe('org/repo', 'mock:1', {})
    expect(s.targets('org/repo', 'push')).toEqual(['mock:1'])
  })
  it('unsubscribe one cid leaves others', () => {
    const s = new SubscriptionStore()
    s.subscribe('org/repo', 'mock:1', {})
    s.subscribe('org/repo', 'mock:2', {})
    s.unsubscribe('org/repo', 'mock:1')
    expect(s.targets('org/repo', 'push')).toEqual(['mock:2'])
  })
  it('unsubscribe without cid drops the whole repo', () => {
    const s = new SubscriptionStore()
    s.subscribe('org/repo', 'mock:1', {})
    s.unsubscribe('org/repo')
    expect(s.targets('org/repo', 'push')).toEqual([])
  })
  it('unknown repo yields no targets', () => {
    expect(new SubscriptionStore().targets('nope/nope', 'push')).toEqual([])
  })
})
