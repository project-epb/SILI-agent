import { describe, it, expect } from 'vitest'
import {
  renderCommitComment,
  renderIssueComment,
  renderPullRequestReviewComment,
} from '../events/comment'

const opts = { bodyMaxLength: 500 }
const repo = { full_name: 'org/repo' }

describe('renderIssueComment', () => {
  const base = {
    action: 'created',
    repository: repo,
    sender: { login: 'alice' },
    issue: { number: 5, pull_request: undefined },
    comment: { user: { login: 'alice', type: 'User' }, body: 'looks good' },
  }
  it('renders a created issue comment with body', () => {
    expect(renderIssueComment(base, opts)).toBe('alice commented on issue org/repo#5\nlooks good')
  })
  it('labels PR comments as pull request', () => {
    const pr = { ...base, issue: { number: 5, pull_request: {} } }
    expect(renderIssueComment(pr, opts)).toBe('alice commented on pull request org/repo#5\nlooks good')
  })
  it('edited action says "edited a comment"', () => {
    expect(renderIssueComment({ ...base, action: 'edited' }, opts))
      .toBe('alice edited a comment on issue org/repo#5\nlooks good')
  })
  it('deleted action produces a delete line and no body', () => {
    expect(renderIssueComment({ ...base, action: 'deleted' }, opts))
      .toBe('alice deleted a comment on issue org/repo#5')
  })
  it('skips bot-authored comments', () => {
    expect(renderIssueComment({ ...base, comment: { user: { login: 'b', type: 'Bot' }, body: 'x' } }, opts)).toBeNull()
  })
})

describe('renderCommitComment', () => {
  it('renders commit id (6) + path + body', () => {
    const p = {
      action: 'created', repository: repo, sender: { login: 'alice' },
      comment: { user: { login: 'alice', type: 'User' }, body: 'nit', commit_id: 'abcdef1234', path: 'a/b.ts' },
    }
    expect(renderCommitComment(p, opts))
      .toBe('alice commented on commit org/repo@abcdef\nPath: a/b.ts\nnit')
  })
})

describe('renderPullRequestReviewComment', () => {
  it('renders review comment with pr number + path + body', () => {
    const p = {
      action: 'created', repository: repo, sender: { login: 'alice' },
      pull_request: { number: 9 },
      comment: { user: { login: 'alice', type: 'User' }, body: 'why?', path: 'a/b.ts' },
    }
    expect(renderPullRequestReviewComment(p, opts))
      .toBe('alice commented on pull request review org/repo#9\nPath: a/b.ts\nwhy?')
  })
})
