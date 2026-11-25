import type { ProviderConfig } from '~/llm'

/**
 * Parse LLM provider configs from environment variables.
 *
 * Convention:
 *   LLM_PROVIDER_{N}_NAME     — unique identifier (required)
 *   LLM_PROVIDER_{N}_TYPE     — 'openai' | 'responses' | 'anthropic' | 'copilot' (required)
 *     'openai' is Chat Completions; 'responses' is the OpenAI Responses API.
 *     For 'copilot', API_KEY is your GitHub OAuth token; BASE_URL is normally
 *     left unset (the endpoint is auto-detected from your Copilot plan).
 *   LLM_PROVIDER_{N}_BASE_URL — API base URL (optional, mainly for openai-compatible)
 *   LLM_PROVIDER_{N}_API_KEY  — API key (optional, SDK can also read from its own env var)
 *   LLM_PROVIDER_{N}_MODEL       — default model override
 *   LLM_PROVIDER_{N}_MAX_TOKENS  — default max tokens override
 *   LLM_PROVIDER_{N}_VISION      — 'true' when the models read images
 *   LLM_PROVIDER_{N}_NATIVE_FILES — 'true' to send images as Files API
 *     file_ids (responses only)
 *   LLM_PROVIDER_{N}_NATIVE_FILES_MAX_BYTES — total kept uploaded; default 1 GiB
 *
 *   LLM_DEFAULT_PROVIDER — name of the provider to use as default. If set and
 *     matched, that provider is moved to index 0 so PluginLLM picks it up as
 *     the default. Unmatched values fall back to the original parse order.
 *
 * Indexes must be contiguous starting from 0.
 */
export function parseLLMProviders(
  env: Record<string, string | undefined>
): ProviderConfig[] {
  const providers: ProviderConfig[] = []

  for (let i = 0; ; i++) {
    const prefix = `LLM_PROVIDER_${i}_`
    const name = env[`${prefix}NAME`]
    const type = env[`${prefix}TYPE`]

    if (!name || !type) break

    const baseURL = env[`${prefix}BASE_URL`]
    const apiKey = env[`${prefix}API_KEY`]
    const model = env[`${prefix}MODEL`]
    const maxTokensRaw = env[`${prefix}MAX_TOKENS`]
    const maxTokens = maxTokensRaw ? Number(maxTokensRaw) : undefined

    const nativeFilesMax = env[`${prefix}NATIVE_FILES_MAX_BYTES`]
    const base = {
      name,
      model: model || undefined,
      maxTokens,
      ...(env[`${prefix}VISION`] === 'true' && { vision: true }),
      ...(env[`${prefix}NATIVE_FILES`] === 'true' && { nativeFiles: true }),
      ...(nativeFilesMax && { nativeFilesMaxBytes: Number(nativeFilesMax) }),
      options: {
        ...(baseURL && { baseURL }),
        ...(apiKey && { apiKey }),
      },
    }

    if (type === 'openai' || type === 'responses' || type === 'anthropic' || type === 'copilot') {
      providers.push({ ...base, type })
    }
  }

  const defaultName = env.LLM_DEFAULT_PROVIDER?.trim()
  if (defaultName) {
    const idx = providers.findIndex((p) => p.name === defaultName)
    if (idx > 0) {
      const [picked] = providers.splice(idx, 1)
      providers.unshift(picked)
    } else if (idx < 0 && providers.length > 0) {
      console.warn(
        `[parseLLMProviders] LLM_DEFAULT_PROVIDER="${defaultName}" not found among configured providers; using parse order.`
      )
    }
  }

  return providers
}
