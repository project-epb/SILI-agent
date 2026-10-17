import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DeepSeekSearchClient,
  unescapeMarkdown,
} from '../services/deepseek-search-client'

function mockFetch(handler: (url: string, body: any) => Response) {
  const fn = vi.fn(async (url: string, init: RequestInit) =>
    handler(url, JSON.parse(String(init.body)))
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DeepSeekSearchClient.search', () => {
  it('posts query and count with the key, and prefers summary over snippet', async () => {
    const fetch = mockFetch(() =>
      json({
        results: [
          {
            title: 'A',
            url: 'https://a',
            snippet: 'short',
            summary: 'long form',
            rerank_score: 2.1,
          },
          { title: 'B', url: 'https://b', snippet: 'only snippet' },
        ],
      })
    )
    const client = new DeepSeekSearchClient({ apiKey: 'k' })
    const resp = await client.search({ query: '天气', maxResults: 3 })

    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://api.deepseek.com/v1/tools/search')
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer k'
    )
    expect(JSON.parse(String(init.body))).toEqual({ query: '天气', count: 3 })
    expect(resp.results).toEqual([
      { title: 'A', url: 'https://a', content: 'long form', score: 2.1 },
      {
        title: 'B',
        url: 'https://b',
        content: 'only snippet',
        score: undefined,
      },
    ])
  })

  it('refuses a query over 128 characters before spending a request', async () => {
    const fetch = mockFetch(() => json({ results: [] }))
    const client = new DeepSeekSearchClient({ apiKey: 'k' })
    await expect(
      client.search({ query: '字'.repeat(129), maxResults: 5 })
    ).rejects.toThrow(/128/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports the status without the body', async () => {
    mockFetch(() => json({ error: { message: 'echo Bearer k' } }, 402))
    const client = new DeepSeekSearchClient({ apiKey: 'k' })
    const err = await client
      .search({ query: 'x', maxResults: 5 })
      .catch((e) => e)
    expect(err.message).toBe(
      'DeepSeek search: account balance exhausted (HTTP 402)'
    )
  })
})

describe('DeepSeekSearchClient.extract', () => {
  it('fetches each URL and keeps a failure from sinking the batch', async () => {
    mockFetch((_url, body) =>
      body.url === 'https://bad'
        ? json({}, 404)
        : json({ title: 'T', content: '\\#\\# Hi https\\:\\/\\/x' })
    )
    const client = new DeepSeekSearchClient({ apiKey: 'k' })
    const resp = await client.extract(['https://ok', 'https://bad'])
    expect(resp.results).toEqual([
      { url: 'https://ok', title: 'T', content: '## Hi https://x' },
    ])
    expect(resp.failed).toEqual([
      {
        url: 'https://bad',
        error: 'DeepSeek fetch: content unavailable (HTTP 404)',
      },
    ])
  })
})

describe('unescapeMarkdown', () => {
  it('drops escapes before ASCII punctuation only', () => {
    expect(unescapeMarkdown('\\*a\\* \\\\ \\n')).toBe('*a* \\ \\n')
  })
})
