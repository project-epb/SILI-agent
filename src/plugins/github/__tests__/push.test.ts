import { describe, it, expect } from 'vitest'
import { renderPush } from '../events/push'
import type { RenderOptions } from '../types'

const opts: RenderOptions = { bodyMaxLength: 500 }

const base = {
  pusher: { name: 'alice' },
  sender: { type: 'User' },
  repository: { full_name: 'org/repo' },
  ref: 'refs/heads/main',
  before: 'a'.repeat(40),
  after: 'b'.repeat(40),
  commits: [{ id: 'abcdef1234', message: 'fix: the thing\n\nlong body' }],
}

describe('renderPush', () => {
  it('renders pusher, branch, and first line of each commit', () => {
    expect(renderPush(base, opts)).toBe('alice pushed to org/repo:main\n[abcdef] fix: the thing')
  })
  it('skips bot pushes', () => {
    expect(renderPush({ ...base, sender: { type: 'Bot' } }, opts)).toBeNull()
  })
  it('skips branch creation (before all zeros)', () => {
    expect(renderPush({ ...base, before: '0'.repeat(40) }, opts)).toBeNull()
  })
  it('skips branch deletion (after all zeros)', () => {
    expect(renderPush({ ...base, after: '0'.repeat(40) }, opts)).toBeNull()
  })
})
