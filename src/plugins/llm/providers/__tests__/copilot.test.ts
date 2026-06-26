import { describe, it, expect } from 'vitest'

import { CopilotProvider } from '../copilot'
import { GithubCopilotAI } from '../copilot-client'

describe('CopilotProvider', () => {
  it('builds a GithubCopilotAI as its underlying client', () => {
    const provider = new CopilotProvider({ apiKey: 'oauth-token' })
    // `client` is protected; reach in for the wiring assertion only.
    const client = (provider as unknown as { client: unknown }).client
    expect(client).toBeInstanceOf(GithubCopilotAI)
  })
})
