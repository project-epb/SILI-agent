import type { EventRenderer } from '../types'
import { cleanBody, issueName } from './util'

export const renderIssues: EventRenderer = (payload, opts) => {
  const { repository, issue, sender, changes } = payload
  const name = issueName(repository, issue)
  switch (payload.action) {
    case 'opened':
      if (changes) return null // ignore the "opened" fired during a transfer
      return [
        `${sender.login} opened an issue ${name}`,
        `Title: ${issue.title}`,
        cleanBody(issue.body, opts.bodyMaxLength),
      ].join('\n')
    case 'closed':
      return `${sender.login} closed issue ${name}\n${issue.title}`
    case 'reopened':
      return `${sender.login} reopened issue ${name}\n${issue.title}`
    case 'transferred': {
      const newName = issueName(changes.new_repository, changes.new_issue)
      return `${sender.login} transferred issue ${name} to ${newName}\n${issue.title}`
    }
    default:
      return null
  }
}
