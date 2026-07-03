import type { EventRenderer } from '../types'

/**
 * Faithful port of the old push renderer. Returns null to skip: bot pushes, and
 * branch create/delete (before/after all-zero SHAs). Commit body is trimmed to
 * its first line (subject) — commit messages are plain text.
 */
export const renderPush: EventRenderer = (payload) => {
  const { pusher, sender, commits, repository, ref, before, after } = payload
  if (sender?.type === 'Bot') return null
  if (/^0+$/.test(before) || /^0+$/.test(after)) return null
  const branch = ref.replace(/^refs\/heads\//, '')
  return [
    `${pusher.name} pushed to ${repository.full_name}:${branch}`,
    ...commits.map((c: any) => `[${c.id.slice(0, 6)}] ${c.message.split('\n')[0]}`),
  ].join('\n')
}
