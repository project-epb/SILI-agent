import type { EventRenderer } from '../types'
import { renderPush } from './push'
import { renderIssues } from './issues'
import {
  renderCommitComment,
  renderIssueComment,
  renderPullRequestReviewComment,
} from './comment'
import { renderPullRequest, renderPullRequestReview } from './pull-request'

/** event name (x-github-event) -> renderer. */
export const renderers: Record<string, EventRenderer> = {
  push: renderPush,
  issues: renderIssues,
  commit_comment: renderCommitComment,
  issue_comment: renderIssueComment,
  pull_request_review_comment: renderPullRequestReviewComment,
  pull_request: renderPullRequest,
  pull_request_review: renderPullRequestReview,
}
