import { describe, it, expect } from 'vitest'
import { buildActions, buildQuoteBody, REACTIONS } from '../actions'

const opts = { bodyMaxLength: 500 }

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

describe('buildQuoteBody', () => {
  it('comment events → the comment body (no header line)', () => {
    const payload = { comment: { body: 'looks good to me' } }
    expect(buildQuoteBody('issue_comment', payload, opts)).toBe('looks good to me')
    expect(buildQuoteBody('commit_comment', payload, opts)).toBe('looks good to me')
    expect(buildQuoteBody('pull_request_review_comment', payload, opts)).toBe('looks good to me')
  })

  it('issues opened → the issue body; other actions → the title', () => {
    const payload = { action: 'opened', issue: { body: 'the description', title: 'Bug' } }
    expect(buildQuoteBody('issues', payload, opts)).toBe('the description')
    expect(buildQuoteBody('issues', { action: 'closed', issue: { title: 'Bug', body: 'x' } }, opts)).toBe('Bug')
  })

  it('pull_request opened → the PR body; other actions → the title', () => {
    expect(buildQuoteBody('pull_request', { action: 'opened', pull_request: { body: 'PR desc', title: 'T' } }, opts))
      .toBe('PR desc')
    expect(buildQuoteBody('pull_request', { action: 'closed', pull_request: { title: 'T', body: 'x' } }, opts))
      .toBe('T')
  })

  it('pull_request_review → the review body', () => {
    expect(buildQuoteBody('pull_request_review', { review: { body: 'nice work' } }, opts)).toBe('nice work')
  })

  it('push / unknown / missing fields → empty string', () => {
    expect(buildQuoteBody('push', { compare: 'C' }, opts)).toBe('')
    expect(buildQuoteBody('star', {}, opts)).toBe('')
    expect(buildQuoteBody('issue_comment', {}, opts)).toBe('')
  })

  it('cuts at the footer INDICATOR so nested quotes accumulate cleanly across bot round-trips', () => {
    // A bot-authored comment carries `> orig\n\nreply\n\n<INDICATOR>footer`; cleanBody drops
    // the footer, leaving the already-nested quote for the next quote-reply to wrap again.
    const body = '> orig\n\nreply\n\n<!-- BOT-MESSAGE-FOOTER -->\nsent via SILI'
    expect(buildQuoteBody('issue_comment', { comment: { body } }, opts)).toBe('> orig\nreply')
  })

  it('truncates to bodyMaxLength', () => {
    expect(buildQuoteBody('issue_comment', { comment: { body: 'abcdefghij' } }, { bodyMaxLength: 3 })).toBe('abc…')
  })
})
