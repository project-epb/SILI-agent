import { cleanBody } from './events/util'
import type { RenderOptions } from './types'

/** The 8 reaction emoji GitHub accepts (squirrel-girl API), in canonical order. */
export const REACTIONS = ['+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes'] as const

/** Quick-reply action name → the ReplyHandler method it dispatches to. */
export type ActionName = 'link' | 'react' | 'reply' | 'close' | 'base' | 'merge' | 'rebase' | 'squash'

/** The actions a pushed message supports; each value is the arg list for ReplyHandler[name]. */
export type ActionMap = Partial<Record<ActionName, any[]>>

/**
 * Pure: map a webhook event + payload to the quick-reply actions it supports.
 * Mirrors the old events.js onComment/onIssue/onPullRequest action maps, minus `.shot`.
 * Events with no interaction return `{}`.
 */
export function buildActions(event: string, payload: any): ActionMap {
  switch (event) {
    case 'issue_comment': {
      const { comment, issue } = payload
      return {
        link: [comment.html_url],
        react: [comment.url + '/reactions'],
        reply: [issue.comments_url],
      }
    }
    case 'commit_comment': {
      const { comment, repository } = payload
      return {
        link: [comment.html_url],
        react: [comment.url + '/reactions'],
        reply: [
          `https://api.github.com/repos/${repository.full_name}/commits/${comment.commit_id}/comments`,
          { path: comment.path, position: comment.position },
        ],
      }
    }
    case 'pull_request_review_comment': {
      const { comment, pull_request, repository } = payload
      return {
        link: [comment.html_url],
        react: [comment.url + '/reactions'],
        reply: [
          `https://api.github.com/repos/${repository.full_name}/pulls/${pull_request.number}/comments/${comment.id}/replies`,
        ],
      }
    }
    case 'issues': {
      const { issue } = payload
      return {
        close: [issue.url, issue.comments_url],
        link: [issue.html_url],
        react: [issue.url + '/reactions'],
        reply: [issue.comments_url],
      }
    }
    case 'pull_request': {
      const { pull_request } = payload
      return {
        base: [pull_request.url],
        close: [pull_request.issue_url, pull_request.comments_url],
        link: [pull_request.html_url],
        merge: [pull_request.url + '/merge'],
        rebase: [pull_request.url + '/merge'],
        squash: [pull_request.url + '/merge'],
        react: [pull_request.issue_url + '/reactions'],
        reply: [pull_request.comments_url],
      }
    }
    case 'pull_request_review': {
      if (payload.action !== 'submitted') return {}
      return {
        link: [payload.review.html_url],
        reply: [payload.pull_request.comments_url],
      }
    }
    case 'push':
      return { link: [payload.compare] }
    default:
      return {}
  }
}

/**
 * Pure: the meaningful, user-authored body of an event — the text a quote-reply
 * prepends as `> ...`. This is the SAME cleanBody the renderer shows, minus the
 * generated header line ("X commented on issue #Y"), so nested `>` accumulates
 * across bot round-trips (cleanBody cuts at the footer INDICATOR). Events with
 * no user-authored body (state changes fall back to the title; push et al.
 * return '').
 */
export function buildQuoteBody(event: string, payload: any, opts: RenderOptions): string {
  const max = opts.bodyMaxLength
  // collapseBlankLines=false: preserve paragraph breaks so nested quote levels stay separated.
  const body = (source: string | undefined) => cleanBody(source, max, false)
  switch (event) {
    case 'issue_comment':
    case 'commit_comment':
    case 'pull_request_review_comment':
      return body(payload.comment?.body)
    case 'issues':
      return body(payload.action === 'opened' ? payload.issue?.body : payload.issue?.title)
    case 'pull_request':
      return body(payload.action === 'opened' ? payload.pull_request?.body : payload.pull_request?.title)
    case 'pull_request_review':
      return body(payload.review?.body)
    default:
      return ''
  }
}
