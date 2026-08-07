/**
 * True if a webhook's sender is an automated actor rather than a human.
 *
 * `sender.type === 'Bot'` covers every GitHub App identity — renovate[bot],
 * dependabot[bot], github-actions[bot] and friends — and is more reliable than
 * matching a '[bot]' login suffix, which some App identities (e.g. Copilot) lack.
 *
 * `extraBotLogins` covers automations running under an ordinary user account
 * (self-hosted renovate, legacy CI accounts): GitHub reports those as type 'User',
 * so nothing in the payload distinguishes them from a human. Logins are compared
 * case-insensitively, matching GitHub's own handling.
 */
export function isAutomatedSender(sender: any, extraBotLogins: string[] = []): boolean {
  if (sender?.type === 'Bot') return true
  const login = String(sender?.login ?? '').toLowerCase()
  if (!login) return false
  return extraBotLogins.some((name) => name.toLowerCase() === login)
}
