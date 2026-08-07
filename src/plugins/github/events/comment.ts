import type { EventRenderer, RenderOptions } from '../types'
import { cleanBody, issueName } from './util'

/** Shared comment wrapper (message text only). Bot filtering happens in webhook.ts. */
function renderComment(payload: any, target: string, opts: RenderOptions): string | null {
  const { user, body } = payload.comment
  if (payload.action === 'deleted') {
    return `${payload.sender.login} deleted a comment on ${target}`
  }
  const operation = payload.action === 'created' ? 'commented' : 'edited a comment'
  return `${user.login} ${operation} on ${target}\n${cleanBody(body, opts.bodyMaxLength)}`
}

export const renderCommitComment: EventRenderer = (payload, opts) => {
  const { repository, comment } = payload
  const target = `commit ${repository.full_name}@${comment.commit_id.slice(0, 6)}\nPath: ${comment.path}`
  return renderComment(payload, target, opts)
}

export const renderIssueComment: EventRenderer = (payload, opts) => {
  const { repository, issue } = payload
  const type = issue.pull_request ? 'pull request' : 'issue'
  const target = `${type} ${issueName(repository, issue)}`
  return renderComment(payload, target, opts)
}

export const renderPullRequestReviewComment: EventRenderer = (payload, opts) => {
  const { repository, comment, pull_request } = payload
  const target = `pull request review ${issueName(repository, pull_request)}\nPath: ${comment.path}`
  return renderComment(payload, target, opts)
}
