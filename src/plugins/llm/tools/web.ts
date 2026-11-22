import type { ToolDefinition } from '../providers/_base'

export const WEB_SEARCH_TOOL: ToolDefinition = {
  name: 'web_search',
  description: '联网搜索，返回标题、URL 和摘要片段。每轮最多 3 次，超出会被拒绝。',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索关键词或自然语言查询，中英文均可',
      },
      max_results: {
        type: 'integer',
        description: '返回结果条数，1-10，默认 5',
        minimum: 1,
        maximum: 10,
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
}

export const EXTRACT_WEBPAGES_TOOL: ToolDefinition = {
  name: 'extract_webpages',
  description: '抓取 1～5 个网页的正文（markdown），一次调用传一批 URL。每轮最多 2 次；失败的 URL 单独标注。',
  parameters: {
    type: 'object',
    properties: {
      urls: {
        type: 'array',
        description: '要抓取的网页 URL 列表（1-5 个，推荐 1-3）',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 5,
      },
    },
    required: ['urls'],
    additionalProperties: false,
  },
}

export interface WebSearchInput {
  query: string
  max_results?: number
}

export interface WebSearchResult {
  title: string
  url: string
  content: string
  score?: number
}

export interface WebSearchResponse {
  results: WebSearchResult[]
  /** Optional engine-synthesized one-paragraph summary (Tavily `answer`). */
  answer?: string
}

/**
 * Backend-agnostic search interface. The tool depends only on this — keeps
 * runWebSearch unit-testable without any HTTP / API key in tests, and lets
 * us swap Tavily for another provider later without touching the tool code.
 */
export interface WebSearchClient {
  search(input: {
    query: string
    maxResults: number
  }): Promise<WebSearchResponse>
}

export interface WebExtractInput {
  urls: string[]
}

export interface WebExtractSuccess {
  url: string
  title?: string
  content: string
}

export interface WebExtractFailure {
  url: string
  error: string
}

export interface WebExtractResponse {
  results: WebExtractSuccess[]
  failed: WebExtractFailure[]
}

export interface WebExtractClient {
  extract(urls: string[]): Promise<WebExtractResponse>
}

/**
 * Per-turn coordination state for the web_search / extract_webpages tools.
 * Tracks call counts so a runaway agent doesn't blow through the Tavily
 * quota in a single turn. Counts are incremented after input validation
 * passes — bad-input rejections don't burn the budget, but network
 * failures and empty-result hits do (to push the agent toward giving up
 * rather than retrying mindlessly).
 */
export interface WebToolsState {
  searchCallCount: number
  extractCallCount: number
}

export const WEB_TOOLS_STATE_KEY = 'webTools'

export function getWebToolsState(
  turnState: Record<string, unknown>
): WebToolsState {
  let s = turnState[WEB_TOOLS_STATE_KEY] as WebToolsState | undefined
  if (!s) {
    s = { searchCallCount: 0, extractCallCount: 0 }
    turnState[WEB_TOOLS_STATE_KEY] = s
  }
  return s
}

/**
 * Pure runner for the web_search tool. Validates input, enforces a
 * per-turn call cap, calls the client, and formats the response into
 * agent-friendly markdown. Errors from the client are caught and
 * returned as `Error: ...` strings (same convention as other tools).
 */
export async function runWebSearch(
  input: WebSearchInput | undefined,
  client: WebSearchClient,
  state: WebToolsState,
  options: {
    defaultMaxResults?: number
    maxResultsCap?: number
    maxCallsPerTurn?: number
  } = {}
): Promise<string> {
  const query = typeof input?.query === 'string' ? input.query.trim() : ''
  if (!query) {
    return 'Error: tool input missing required field "query"'
  }
  const callCap = options.maxCallsPerTurn ?? 3
  if (state.searchCallCount >= callCap) {
    return `Error: web_search 这一轮已经调用 ${state.searchCallCount} 次（上限 ${callCap}）。如果几次搜索都没找到有用信息，就如实告诉用户「SILI 搜了几次都没查到靠谱的内容」，不要继续硬搜。`
  }
  const cap = options.maxResultsCap ?? 10
  const def = options.defaultMaxResults ?? 5
  let n =
    typeof input?.max_results === 'number' && Number.isFinite(input.max_results)
      ? Math.floor(input.max_results)
      : def
  if (n < 1) n = def
  if (n > cap) n = cap

  state.searchCallCount += 1
  let resp: WebSearchResponse
  try {
    resp = await client.search({ query, maxResults: n })
  } catch (e: any) {
    return `Error: web search failed: ${e?.message || String(e)}`
  }

  const results = resp?.results ?? []
  const remaining = Math.max(0, callCap - state.searchCallCount)
  const tail =
    remaining > 0
      ? `\n\n（本轮还可再 search ${remaining} 次；如已足够请直接回答，不要凑数）`
      : '\n\n（本轮 search 配额已用完，下一步只能 extract 或直接回答）'

  if (!results.length) {
    return `(没有搜到与 "${query}" 相关的结果，可以换个关键词重试)${tail}`
  }

  const lines: string[] = [`# 搜索结果："${query}"`]
  if (resp.answer && resp.answer.trim()) {
    lines.push('', `**摘要**：${resp.answer.trim()}`)
  }
  results.forEach((r, i) => {
    lines.push('', `## ${i + 1}. ${r.title?.trim() || '(无标题)'}`)
    if (r.url) lines.push(`URL: ${r.url}`)
    const content = r.content?.trim()
    if (content) lines.push('', content)
  })
  return (lines.join('\n').trim() + tail).trim()
}

/**
 * Pure runner for extract_webpages. Validates input (1..maxUrlsPerCall
 * URLs, all non-empty strings), enforces per-turn cap, calls the
 * client, and formats results + failures into a single markdown blob.
 */
export async function runWebExtract(
  input: WebExtractInput | undefined,
  client: WebExtractClient,
  state: WebToolsState,
  options: {
    maxUrlsPerCall?: number
    maxCallsPerTurn?: number
  } = {}
): Promise<string> {
  const maxUrls = options.maxUrlsPerCall ?? 5
  if (!input || !Array.isArray(input.urls)) {
    return 'Error: tool input missing required field "urls" (array of URL strings)'
  }
  const urls = input.urls
    .filter((u): u is string => typeof u === 'string')
    .map((u) => u.trim())
    .filter((u) => u.length > 0)
  if (!urls.length) {
    return 'Error: "urls" is empty after trimming — pass 1-5 valid URL strings.'
  }
  if (urls.length > maxUrls) {
    return `Error: too many URLs (${urls.length}); cap is ${maxUrls} per call. 挑 1-3 个最相关的 URL 重新提交。`
  }

  const callCap = options.maxCallsPerTurn ?? 2
  if (state.extractCallCount >= callCap) {
    return `Error: extract_webpages 这一轮已经调用 ${state.extractCallCount} 次（上限 ${callCap}）。如果还没拿到想要的信息，就基于现有内容回答用户，或承认「这个 SILI 也查不到」。`
  }

  state.extractCallCount += 1
  let resp: WebExtractResponse
  try {
    resp = await client.extract(urls)
  } catch (e: any) {
    return `Error: web extract failed: ${e?.message || String(e)}`
  }

  const ok = resp?.results ?? []
  const failed = resp?.failed ?? []
  if (!ok.length && !failed.length) {
    return `(extract 没有返回任何结果，输入 URL: ${urls.join(', ')})`
  }

  const lines: string[] = []
  ok.forEach((r, i) => {
    lines.push(`## ${i + 1}. ${r.title?.trim() || r.url}`)
    lines.push(`URL: ${r.url}`)
    const content = r.content?.trim()
    if (content) {
      lines.push('', content)
    } else {
      lines.push('', '(页面内容为空)')
    }
    lines.push('')
  })
  if (failed.length) {
    lines.push('## 抓取失败的 URL')
    failed.forEach((f) => {
      lines.push(`- ${f.url} — ${f.error}`)
    })
  }
  return lines.join('\n').trim()
}
