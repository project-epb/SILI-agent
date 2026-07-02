import type { EventRenderer } from '../types'
import { renderPush } from './push'
import { renderIssues } from './issues'
import {
  renderCommitComment,
  renderIssueComment,
  renderPullRequestReviewComment,
} from './comment'

/** event name (x-github-event) -> renderer. */
export const renderers: Record<string, EventRenderer> = {
  push: renderPush,
  issues: renderIssues,
  commit_comment: renderCommitComment,
  issue_comment: renderIssueComment,
  pull_request_review_comment: renderPullRequestReviewComment,
}
