import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { GithubCopilotAI } from '../copilot-client'

// Minimal valid token-endpoint payload; only token + expires_at matter.
const authPayload = (expiresAt: number) => ({
  token: `tok-${expiresAt}`,
  expires_at: expiresAt,
})

describe('GithubCopilotAI token cache', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-26T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('fetches once then reuses an unexpired token', async () => {
    const nowSec = Date.now() / 1000
    fetchSpy = vi.fn(async () => ({
      json: async () => authPayload(nowSec + 3600),
    }))
    vi.stubGlobal('fetch', fetchSpy)

    const client = new GithubCopilotAI({ apiKey: 'oauth-token' })
    const a1 = await client.getCopilotInternalAuth()
    const a2 = await client.getCopilotInternalAuth()

    expect(a1.token).toBe(a2.token)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('refetches after the token expires', async () => {
    const t0 = Date.now() / 1000
    fetchSpy = vi.fn(async () => ({
      json: async () => authPayload(Date.now() / 1000 + 10),
    }))
    vi.stubGlobal('fetch', fetchSpy)

    const client = new GithubCopilotAI({ apiKey: 'oauth-token' })
    await client.getCopilotInternalAuth()
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date((t0 + 20) * 1000))
    await client.getCopilotInternalAuth()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('setCopilotInternalAuth returns null for null / already-expired payloads', () => {
    const client = new GithubCopilotAI({ apiKey: 'oauth-token' })
    expect(client.setCopilotInternalAuth(null)).toBeNull()
    const expired = { token: 't', expires_at: Date.now() / 1000 - 1 } as any
    expect(client.setCopilotInternalAuth(expired)).toBeNull()
  })

  it('setCopilotInternalAuth throws on payloads missing token/expires_at', () => {
    const client = new GithubCopilotAI({ apiKey: 'oauth-token' })
    expect(() => client.setCopilotInternalAuth({} as any)).toThrow(
      'Invalid payload'
    )
  })
})
