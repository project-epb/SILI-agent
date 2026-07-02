import { describe, it, expect } from 'vitest'
import { renderIssues } from '../events/issues'

const opts = { bodyMaxLength: 500 }
const repo = { full_name: 'org/repo' }
const base = {
  repository: repo,
  sender: { login: 'alice' },
  issue: { number: 3, title: 'Bug', body: 'it breaks', user: { type: 'User' } },
}

describe('renderIssues', () => {
  it('opened: sender + name + title + body', () => {
    expect(renderIssues({ ...base, action: 'opened' }, opts))
      .toBe('alice opened an issue org/repo#3\nTitle: Bug\nit breaks')
  })
  it('opened with changes (transfer artifact) is skipped', () => {
    expect(renderIssues({ ...base, action: 'opened', changes: { foo: 1 } }, opts)).toBeNull()
  })
  it('closed: sender closed + name + title', () => {
    expect(renderIssues({ ...base, action: 'closed' }, opts))
      .toBe('alice closed issue org/repo#3\nBug')
  })
  it('reopened', () => {
    expect(renderIssues({ ...base, action: 'reopened' }, opts))
      .toBe('alice reopened issue org/repo#3\nBug')
  })
  it('transferred: old -> new name + title', () => {
    const p = {
      ...base, action: 'transferred',
      changes: { new_issue: { number: 8 }, new_repository: { full_name: 'org/other' } },
    }
    expect(renderIssues(p, opts))
      .toBe('alice transferred issue org/repo#3 to org/other#8\nBug')
  })
  it('skips bot-authored issues', () => {
    expect(renderIssues({ ...base, action: 'opened', issue: { ...base.issue, user: { type: 'Bot' } } }, opts)).toBeNull()
  })
  it('unknown action -> null', () => {
    expect(renderIssues({ ...base, action: 'labeled' }, opts)).toBeNull()
  })
})
