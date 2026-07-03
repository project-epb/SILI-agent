import { describe, it, expect } from 'vitest'
import { renderPullRequest, renderPullRequestReview } from '../events/pull-request'

const opts = { bodyMaxLength: 500 }
const repo = { full_name: 'org/repo', owner: { login: 'org' } }
const pr = {
  number: 12, title: 'Add X', body: 'does X', draft: false, merged: false,
  user: { type: 'User' },
  base: { label: 'org:main' }, head: { label: 'org:feature' },
}
const base = { repository: repo, sender: { login: 'alice' }, pull_request: pr }

describe('renderPullRequest', () => {
  it('opened: header with base <- head, title, body; strips owner: prefix from labels', () => {
    expect(renderPullRequest({ ...base, action: 'opened' }, opts))
      .toBe('alice opened a pull request org/repo#12 (main ← feature)\nTitle: Add X\ndoes X')
  })
  it('opened draft says drafted', () => {
    expect(renderPullRequest({ ...base, action: 'opened', pull_request: { ...pr, draft: true } }, opts))
      .toBe('alice drafted a pull request org/repo#12 (main ← feature)\nTitle: Add X\ndoes X')
  })
  it('closed unmerged', () => {
    expect(renderPullRequest({ ...base, action: 'closed' }, opts))
      .toBe('alice closed pull request org/repo#12\nAdd X')
  })
  it('closed merged says merged', () => {
    expect(renderPullRequest({ ...base, action: 'closed', pull_request: { ...pr, merged: true } }, opts))
      .toBe('alice merged pull request org/repo#12\nAdd X')
  })
  it('reopened', () => {
    expect(renderPullRequest({ ...base, action: 'reopened' }, opts))
      .toBe('alice reopened pull request org/repo#12\nAdd X')
  })
  it('review_requested from a user', () => {
    expect(renderPullRequest({ ...base, action: 'review_requested', requested_reviewer: { login: 'bob' } }, opts))
      .toBe('alice requested a review from bob on org/repo#12')
  })
  it('review_requested from a team', () => {
    expect(renderPullRequest({ ...base, action: 'review_requested', requested_team: { name: 'core' } }, opts))
      .toBe('alice requested a review from team core on org/repo#12')
  })
  it('converted_to_draft', () => {
    expect(renderPullRequest({ ...base, action: 'converted_to_draft' }, opts))
      .toBe('alice marked org/repo#12 as draft')
  })
  it('ready_for_review', () => {
    expect(renderPullRequest({ ...base, action: 'ready_for_review' }, opts))
      .toBe('alice marked org/repo#12 as ready for review')
  })
  it('skips bot-authored PRs', () => {
    expect(renderPullRequest({ ...base, action: 'opened', pull_request: { ...pr, user: { type: 'Bot' } } }, opts)).toBeNull()
  })
  it('unknown action -> null', () => {
    expect(renderPullRequest({ ...base, action: 'labeled' }, opts)).toBeNull()
  })
})

describe('renderPullRequestReview', () => {
  const rbase = {
    action: 'submitted', repository: repo, pull_request: pr,
    review: { body: 'LGTM', user: { login: 'bob', type: 'User' } },
  }
  it('submitted with body', () => {
    expect(renderPullRequestReview(rbase, opts)).toBe('bob reviewed pull request org/repo#12\nLGTM')
  })
  it('empty review body -> null', () => {
    expect(renderPullRequestReview({ ...rbase, review: { body: '', user: { type: 'User' } } }, opts)).toBeNull()
  })
  it('non-submitted action -> null', () => {
    expect(renderPullRequestReview({ ...rbase, action: 'edited' }, opts)).toBeNull()
  })
  it('bot reviewer -> null', () => {
    expect(renderPullRequestReview({ ...rbase, review: { body: 'x', user: { type: 'Bot' } } }, opts)).toBeNull()
  })
})
