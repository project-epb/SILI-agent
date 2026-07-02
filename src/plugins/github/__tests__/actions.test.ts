import { describe, it, expect } from 'vitest'
import { buildActions, REACTIONS } from '../actions'

describe('REACTIONS', () => {
  it('is the 8 github reaction names in order', () => {
    expect(REACTIONS).toEqual(['+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes'])
  })
})

describe('buildActions', () => {
  it('issue_comment → link/react/reply', () => {
    const payload = {
      comment: { html_url: 'H', url: 'https://api/c' },
      issue: { comments_url: 'https://api/i/comments' },
    }
    expect(buildActions('issue_comment', payload)).toEqual({
      link: ['H'],
      react: ['https://api/c/reactions'],
      reply: ['https://api/i/comments'],
    })
  })

  it('commit_comment → reply targets the commit comments url with path/position', () => {
    const payload = {
      repository: { full_name: 'o/r' },
      comment: { html_url: 'H', url: 'https://api/c', commit_id: 'abc123', path: 'a.ts', position: 4 },
    }
    expect(buildActions('commit_comment', payload)).toEqual({
      link: ['H'],
      react: ['https://api/c/reactions'],
      reply: ['https://api.github.com/repos/o/r/commits/abc123/comments', { path: 'a.ts', position: 4 }],
    })
  })

  it('pull_request_review_comment → reply targets the review-comment replies url', () => {
    const payload = {
      repository: { full_name: 'o/r' },
      pull_request: { number: 7 },
      comment: { html_url: 'H', url: 'https://api/c', id: 55 },
    }
    expect(buildActions('pull_request_review_comment', payload)).toEqual({
      link: ['H'],
      react: ['https://api/c/reactions'],
      reply: ['https://api.github.com/repos/o/r/pulls/7/comments/55/replies'],
    })
  })

  it('issues → close/link/react/reply', () => {
    const payload = {
      issue: { url: 'https://api/i', html_url: 'H', comments_url: 'https://api/i/comments' },
    }
    expect(buildActions('issues', payload)).toEqual({
      close: ['https://api/i', 'https://api/i/comments'],
      link: ['H'],
      react: ['https://api/i/reactions'],
      reply: ['https://api/i/comments'],
    })
  })

  it('pull_request → base/close/link/merge/rebase/squash/react/reply', () => {
    const payload = {
      pull_request: {
        url: 'https://api/pr',
        issue_url: 'https://api/i',
        html_url: 'H',
        comments_url: 'https://api/i/comments',
      },
    }
    expect(buildActions('pull_request', payload)).toEqual({
      base: ['https://api/pr'],
      close: ['https://api/i', 'https://api/i/comments'],
      link: ['H'],
      merge: ['https://api/pr/merge'],
      rebase: ['https://api/pr/merge'],
      squash: ['https://api/pr/merge'],
      react: ['https://api/i/reactions'],
      reply: ['https://api/i/comments'],
    })
  })

  it('pull_request_review only acts on submitted', () => {
    const submitted = {
      action: 'submitted',
      review: { html_url: 'H' },
      pull_request: { comments_url: 'https://api/i/comments' },
    }
    expect(buildActions('pull_request_review', submitted)).toEqual({
      link: ['H'],
      reply: ['https://api/i/comments'],
    })
    expect(buildActions('pull_request_review', { action: 'dismissed' })).toEqual({})
  })

  it('push → link only; no-interaction events → empty', () => {
    expect(buildActions('push', { compare: 'C' })).toEqual({ link: ['C'] })
    expect(buildActions('star', {})).toEqual({})
    expect(buildActions('fork', {})).toEqual({})
    expect(buildActions('milestone', {})).toEqual({})
  })
})
