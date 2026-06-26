import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { parseLLMProviders } from '../parseLLMProviders'

const baseEnv = (extra: Record<string, string> = {}) => ({
  LLM_PROVIDER_0_NAME: 'main',
  LLM_PROVIDER_0_TYPE: 'openai',
  LLM_PROVIDER_0_API_KEY: 'k0',
  LLM_PROVIDER_1_NAME: 'fallback',
  LLM_PROVIDER_1_TYPE: 'anthropic',
  LLM_PROVIDER_1_API_KEY: 'k1',
  ...extra,
})

describe('parseLLMProviders', () => {
  it('parses providers in env index order by default', () => {
    const out = parseLLMProviders(baseEnv())
    expect(out.map((p) => p.name)).toEqual(['main', 'fallback'])
  })

  it('stops at first missing index', () => {
    const out = parseLLMProviders({
      LLM_PROVIDER_0_NAME: 'a',
      LLM_PROVIDER_0_TYPE: 'openai',
      LLM_PROVIDER_2_NAME: 'c',
      LLM_PROVIDER_2_TYPE: 'openai',
    })
    expect(out.map((p) => p.name)).toEqual(['a'])
  })

  it('moves LLM_DEFAULT_PROVIDER to index 0', () => {
    const out = parseLLMProviders(
      baseEnv({ LLM_DEFAULT_PROVIDER: 'fallback' })
    )
    expect(out.map((p) => p.name)).toEqual(['fallback', 'main'])
  })

  it('keeps order when LLM_DEFAULT_PROVIDER already at index 0', () => {
    const out = parseLLMProviders(baseEnv({ LLM_DEFAULT_PROVIDER: 'main' }))
    expect(out.map((p) => p.name)).toEqual(['main', 'fallback'])
  })

  it('trims whitespace around LLM_DEFAULT_PROVIDER', () => {
    const out = parseLLMProviders(
      baseEnv({ LLM_DEFAULT_PROVIDER: '  fallback  ' })
    )
    expect(out[0].name).toBe('fallback')
  })

  it('parses a copilot provider with apiKey as the GitHub OAuth token', () => {
    const out = parseLLMProviders({
      LLM_PROVIDER_0_NAME: 'copilot',
      LLM_PROVIDER_0_TYPE: 'copilot',
      LLM_PROVIDER_0_API_KEY: 'gho_token',
    })
    expect(out).toEqual([
      {
        name: 'copilot',
        model: undefined,
        maxTokens: undefined,
        type: 'copilot',
        options: { apiKey: 'gho_token' },
      },
    ])
  })

  describe('with unmatched LLM_DEFAULT_PROVIDER', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      warnSpy.mockRestore()
    })

    it('falls back to parse order and warns', () => {
      const out = parseLLMProviders(
        baseEnv({ LLM_DEFAULT_PROVIDER: 'nonexistent' })
      )
      expect(out.map((p) => p.name)).toEqual(['main', 'fallback'])
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0][0]).toContain('nonexistent')
    })

    it('does not warn when no providers are configured', () => {
      const out = parseLLMProviders({ LLM_DEFAULT_PROVIDER: 'nope' })
      expect(out).toEqual([])
      expect(warnSpy).not.toHaveBeenCalled()
    })
  })
})
