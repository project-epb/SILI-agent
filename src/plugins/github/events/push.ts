import type { EventRenderer } from '../types'

/**
 * Returns null to skip branch create/delete (before/after all-zero SHAs) — those arrive
 * as their own `create`/`delete` events. Commit body is trimmed to its first line
 * (subject) — commit messages are plain text.
 *
 * Bot filtering is NOT done here: it is sender-based and config-driven in webhook.ts.
 */
export const renderPush: EventRenderer = (payload) => {
  const { pusher, commits, repository, ref, before, after } = payload
  if (/^0+$/.test(before) || /^0+$/.test(after)) return null
  const branch = ref.replace(/^refs\/heads\//, '')
  return [
    `${pusher.name} pushed to ${repository.full_name}:${branch}`,
    ...commits.map((c: any) => `[${c.id.slice(0, 6)}] ${c.message.split('\n')[0]}`),
  ].join('\n')
}
