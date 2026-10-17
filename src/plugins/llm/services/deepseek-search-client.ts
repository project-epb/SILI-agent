import type {
  WebExtractClient,
  WebExtractResponse,
  WebSearchClient,
  WebSearchResponse,
} from '../tools'

const BASE_URL = 'https://api.deepseek.com/v1/tools'

/** The Search API rejects longer queries with a 400. */
export const DEEPSEEK_QUERY_MAX_CHARS = 128

/** What each documented status means, so the agent can tell a retry from a dead end. */
const STATUS_REASONS: Record<number, string> = {
  400: 'invalid request',
  401: 'API key rejected',
  402: 'account balance exhausted',
  403: 'rejected by the security check',
  404: 'content unavailable',
  408: 'timed out, retryable',
  413: 'request too large',
  429: 'rate limited, retryable',
  504: 'upstream timed out, retryable',
}

export class DeepSeekRequestError extends Error {
  constructor(
    endpoint: string,
    readonly status: number
  ) {
    const reason =
      STATUS_REASONS[status] ??
      (status >= 500 ? 'server error, retryable' : 'request failed')
    // The body may quote the request back; surface the status only so a key cannot reach a log.
    super(`DeepSeek ${endpoint}: ${reason} (HTTP ${status})`)
  }
}

interface DeepSeekSearchWire {
  results?: {
    title?: string
    url?: string
    snippet?: string
    summary?: string
    rerank_score?: number
  }[]
}

interface DeepSeekFetchWire {
  title?: string
  content?: string
}

/**
 * Fetch escapes every ASCII punctuation mark in the page (`\#\# https\:\/\/`)
 * and keeps no code fences or links for an escape to protect. Undoing it is
 * what a markdown renderer would do, and spares the agent a backslash on
 * every other character.
 */
export function unescapeMarkdown(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, '$1')
}

export interface DeepSeekSearchClientOptions {
  apiKey: string
  /** Per-request timeout in seconds. Default 15. */
  timeoutSeconds?: number
}

/**
 * DeepSeek's Search and Fetch APIs. They are billed to, and authenticated
 * by, the same account as its chat models, so the `deepseek` provider's key
 * serves both. Both APIs are limited to 5 QPS per account.
 */
export class DeepSeekSearchClient implements WebSearchClient, WebExtractClient {
  private readonly apiKey: string
  private readonly timeoutMs: number

  constructor(options: DeepSeekSearchClientOptions) {
    if (!options.apiKey) {
      throw new Error('DeepSeekSearchClient: apiKey is required')
    }
    this.apiKey = options.apiKey
    this.timeoutMs = (options.timeoutSeconds ?? 15) * 1000
  }

  private async post<T>(
    endpoint: 'search' | 'fetch',
    body: Record<string, unknown>
  ): Promise<T> {
    const resp = await fetch(`${BASE_URL}/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!resp.ok) throw new DeepSeekRequestError(endpoint, resp.status)
    return (await resp.json()) as T
  }

  async search(input: {
    query: string
    maxResults: number
  }): Promise<WebSearchResponse> {
    if ([...input.query].length > DEEPSEEK_QUERY_MAX_CHARS) {
      throw new Error(
        `query 超过 ${DEEPSEEK_QUERY_MAX_CHARS} 字符，请缩短关键词`
      )
    }
    const wire = await this.post<DeepSeekSearchWire>('search', {
      query: input.query,
      count: input.maxResults,
    })
    return {
      results: (wire.results ?? []).map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        // summary is the long form meant for models; snippet is a short UI blurb.
        content: r.summary || r.snippet || '',
        score: typeof r.rerank_score === 'number' ? r.rerank_score : undefined,
      })),
    }
  }

  /**
   * One request per URL — the API takes one — run together. The tool caps a
   * batch at 5 URLs, within the account's 5 QPS, so a batch does not throttle
   * itself.
   */
  async extract(urls: string[]): Promise<WebExtractResponse> {
    const settled = await Promise.allSettled(
      urls.map((url) => this.post<DeepSeekFetchWire>('fetch', { url }))
    )
    const out: WebExtractResponse = { results: [], failed: [] }
    settled.forEach((outcome, i) => {
      const url = urls[i]!
      if (outcome.status === 'rejected') {
        const reason = outcome.reason
        out.failed.push({
          url,
          error: reason instanceof Error ? reason.message : String(reason),
        })
        return
      }
      out.results.push({
        url,
        title: outcome.value.title || undefined,
        content: unescapeMarkdown(outcome.value.content ?? ''),
      })
    })
    return out
  }
}
