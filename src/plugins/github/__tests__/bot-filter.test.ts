import { describe, it, expect } from 'vitest'
import { isAutomatedSender } from '../bot-filter'

describe('isAutomatedSender', () => {
  it('detects a GitHub App identity by sender.type', () => {
    // Every App-backed actor (renovate/dependabot/actions) reports type 'Bot',
    // even the ones whose login carries no '[bot]' suffix (e.g. Copilot).
    expect(isAutomatedSender({ type: 'Bot', login: 'renovate[bot]' })).toBe(true)
    expect(isAutomatedSender({ type: 'Bot', login: 'Copilot' })).toBe(true)
  })

  it('lets an ordinary human sender through', () => {
    expect(isAutomatedSender({ type: 'User', login: 'alice' })).toBe(false)
  })

  it('detects a listed automation running under a user account', () => {
    // Self-hosted renovate / legacy CI accounts are reported as type 'User'.
    expect(isAutomatedSender({ type: 'User', login: 'renovate-bot' }, ['renovate-bot'])).toBe(true)
  })

  it('matches listed logins case-insensitively', () => {
    expect(isAutomatedSender({ type: 'User', login: 'Renovate-Bot' }, ['renovate-bot'])).toBe(true)
    expect(isAutomatedSender({ type: 'User', login: 'renovate-bot' }, ['Renovate-Bot'])).toBe(true)
  })

  it('does not match a sender outside the list', () => {
    expect(isAutomatedSender({ type: 'User', login: 'alice' }, ['renovate-bot'])).toBe(false)
  })

  it('tolerates a missing or empty sender', () => {
    expect(isAutomatedSender(undefined)).toBe(false)
    expect(isAutomatedSender({})).toBe(false)
    // An empty login must not be matched by an empty list entry.
    expect(isAutomatedSender({ type: 'User' }, [''])).toBe(false)
  })
})
