import type { EventRenderer } from '../types'
import { cleanBody, issueName } from './util'

export const renderPullRequest: EventRenderer = (payload, opts) => {
  const { repository, sender } = payload
  const pr = payload.pull_request
  const name = issueName(repository, pr)
  switch (payload.action) {
    case 'opened': {
      const prefix = new RegExp(`^${repository.owner.login}:`)
      const baseLabel = pr.base.label.replace(prefix, '')
      const headLabel = pr.head.label.replace(prefix, '')
      return [
        `${sender.login} ${pr.draft ? 'drafted' : 'opened'} a pull request ${name} (${baseLabel} ← ${headLabel})`,
        `Title: ${pr.title}`,
        cleanBody(pr.body, opts.bodyMaxLength),
      ].join('\n')
    }
    case 'closed':
      return `${sender.login} ${pr.merged ? 'merged' : 'closed'} pull request ${name}\n${pr.title}`
    case 'reopened':
      return `${sender.login} reopened pull request ${name}\n${pr.title}`
    case 'review_requested':
      return 'requested_reviewer' in payload
        ? `${sender.login} requested a review from ${payload.requested_reviewer.login} on ${name}`
        : `${sender.login} requested a review from team ${payload.requested_team.name} on ${name}`
    case 'converted_to_draft':
      return `${sender.login} marked ${name} as draft`
    case 'ready_for_review':
      return `${sender.login} marked ${name} as ready for review`
    default:
      return null
  }
}

export const renderPullRequestReview: EventRenderer = (payload, opts) => {
  if (payload.action !== 'submitted') return null
  const { review, repository, pull_request } = payload
  if (!review.body) return null
  const name = issueName(repository, pull_request)
  return [
    `${review.user.login} reviewed pull request ${name}`,
    cleanBody(review.body, opts.bodyMaxLength),
  ].join('\n')
}
