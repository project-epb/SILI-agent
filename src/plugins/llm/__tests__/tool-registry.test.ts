import { describe, it, expect, vi } from 'vitest'
import {
  EXTRACT_WEBPAGES_TOOL,
  type MemoryTier,
  type MemoryToolState,
  type ToolContext,
  ToolRegistry,
  WEB_SEARCH_TOOL,
  type WebExtractClient,
  type WebExtractResponse,
  type WebSearchClient,
  type WebSearchResponse,
  type WebToolsState,
  buildSaveUserMemoryTool,
  executeKoishiCommandHandler,
  getMemoryToolState,
  getWebToolsState,
  isForbiddenAgentCommand,
  renderAgentHelp,
  runReadUserMemory,
  runSaveUserMemory,
  runWebExtract,
  runWebSearch,
  type ToolHandler,
} from '../tools'
import type { CommandCatalogEntry } from '../utils/command-catalog'
import { byteLength } from '../services/memory'

const fakeHandler = (name: string, result = 'ok'): ToolHandler => ({
  definition: {
    name,
    description: `${name} desc`,
    parameters: { type: 'object', properties: {}, required: [] },
  },
  async execute() {
    return result
  },
})

describe('ToolRegistry', () => {
  it('starts empty', () => {
    const r = new ToolRegistry()
    expect(r.listDefinitions()).toEqual([])
    expect(r.get('foo')).toBeUndefined()
  })

  it('registers and retrieves a handler', () => {
    const r = new ToolRegistry()
    const h = fakeHandler('foo')
    r.register(h)
    expect(r.get('foo')).toBe(h)
    expect(r.listDefinitions()).toEqual([h.definition])
  })

  it('overwrites a handler with same name', () => {
    const r = new ToolRegistry()
    const a = fakeHandler('foo', 'a')
    const b = fakeHandler('foo', 'b')
    r.register(a)
    r.register(b)
    expect(r.get('foo')).toBe(b)
    expect(r.listDefinitions()).toHaveLength(1)
  })

  it('unregisters a handler', () => {
    const r = new ToolRegistry()
    r.register(fakeHandler('foo'))
    r.unregister('foo')
    expect(r.get('foo')).toBeUndefined()
    expect(r.listDefinitions()).toEqual([])
  })

  it('lists definitions in registration order', () => {
    const r = new ToolRegistry()
    r.register(fakeHandler('a'))
    r.register(fakeHandler('b'))
    r.register(fakeHandler('c'))
    expect(r.listDefinitions().map((d) => d.name)).toEqual(['a', 'b', 'c'])
  })
})

describe('isForbiddenAgentCommand', () => {
  it.each(['chat', 'llm', 'llm.reset', 'llm.memory', 'llm.catalog', 'llm.providers'])(
    'forbids %s',
    (name) => {
      expect(isForbiddenAgentCommand(name)).toBe(true)
    }
  )

  it.each(['pixiv.illust', 'homo', 'sticker', 'help', 'mediawiki', 'llmm', 'chat-history'])(
    'allows %s',
    (name) => {
      expect(isForbiddenAgentCommand(name)).toBe(false)
    }
  )

  it('does not match substrings (only prefix)', () => {
    expect(isForbiddenAgentCommand('foo.llm.bar')).toBe(false)
    expect(isForbiddenAgentCommand('not-llm.x')).toBe(false)
  })
})

describe('renderAgentHelp', () => {
  const catalog: CommandCatalogEntry[] = [
    {
      name: 'wiki',
      description: 'wiki cmd',
      args: [],
      options: [],
      aliases: [],
      children: [
        {
          name: 'wiki.connect',
          description: 'connect',
          args: [],
          options: [],
          aliases: [],
          children: [
            {
              name: 'wiki.connect.group',
              description: '连接群聊',
              args: [],
              options: [],
              aliases: [],
              children: [],
            },
          ],
        },
      ],
    },
    {
      name: 'help',
      description: 'show help',
      args: [],
      options: [],
      aliases: [],
      children: [],
    },
  ]

  it('lists top-level commands when called without an arg', () => {
    const out = renderAgentHelp(catalog)
    expect(out).toContain('`wiki`')
    expect(out).toContain('`help`')
    // 不应该展开子命令
    expect(out).not.toContain('`wiki.connect`')
  })

  it('renders detail for a known top-level command', () => {
    const out = renderAgentHelp(catalog, 'wiki')
    expect(out).toContain('# wiki')
    expect(out).toContain('## 子指令')
    expect(out).toContain('`wiki.connect`')
  })

  it('renders detail for a nested command queried by full dot name', () => {
    const out = renderAgentHelp(catalog, 'wiki.connect')
    expect(out).toContain('# wiki.connect')
    expect(out).toContain('connect')
  })

  it('points to command search when a name does not match', () => {
    expect(renderAgentHelp(catalog, 'connect')).toContain('`_find_command_`')
  })

  it('returns placeholder when catalog is empty and no arg', () => {
    expect(renderAgentHelp([])).toBe('(暂无可用指令)')
  })

  describe('_find_command_', () => {
    const sessionExecute = vi.fn()
    const search = (args: string[]) =>
      executeKoishiCommandHandler.execute(
        { name: '_find_command_', args },
        {
          ctx: { llm: { getCatalog: () => catalog } },
          session: { execute: sessionExecute },
        } as unknown as ToolContext
      )

    it.each([' CONNECT ', '群聊'])(
      'finds deep commands by keyword %s',
      async (query) => {
        expect(await search([query])).toContain('`wiki.connect.group` — 连接群聊')
        expect(sessionExecute).not.toHaveBeenCalled()
      }
    )

    it('lists descendants when the query is also an exact command name', async () => {
      const result = await search(['wiki.connect'])
      expect(result).toContain('`wiki.connect` — connect')
      expect(result).toContain('`wiki.connect.group` — 连接群聊')
    })

    it('asks for a keyword when none is provided', async () => {
      expect(await search([])).toContain('请在 `args[0]` 提供搜索关键词')
    })
  })
})

describe('runReadUserMemory', () => {
  const makeMemory = (
    table: Record<string, { content: string; last_updated_at: number }>
  ) => ({
    async getMeta(platform: string, userId: string) {
      const row = table[`${platform}/${userId}`]
      if (!row) return null
      return {
        id: 1,
        platform,
        user_id: userId,
        content: row.content,
        byte_size: byteLength(row.content),
        last_updated_at: row.last_updated_at,
        last_check_at: row.last_updated_at,
        update_count: 1,
        message_count_at_update: 0,
        last_forked_conversation_id: '',
      }
    },
  })

  it('returns the memory text when present', async () => {
    const memory = makeMemory({
      'qq/u1': { content: '- 喜欢吃热干面', last_updated_at: 100 },
    })
    const out = await runReadUserMemory(memory, 'qq', 'u1')
    expect(out.text).toBe('- 喜欢吃热干面')
    expect(out.lastUpdatedAt).toBe(100)
  })

  it('returns the placeholder when memory is empty string', async () => {
    const memory = makeMemory({
      'qq/u1': { content: '', last_updated_at: 0 },
    })
    const out = await runReadUserMemory(memory, 'qq', 'u1')
    expect(out.text).toBe('(暂无记录)')
    expect(out.lastUpdatedAt).toBe(0)
  })

  it('returns the placeholder when memory is whitespace only', async () => {
    const memory = makeMemory({
      'qq/u1': { content: '   \n  \t ', last_updated_at: 50 },
    })
    const out = await runReadUserMemory(memory, 'qq', 'u1')
    expect(out.text).toBe('(暂无记录)')
    // lastUpdatedAt 仍要返回，让乐观锁能识别"曾经有过 record"
    expect(out.lastUpdatedAt).toBe(50)
  })

  it('keys on (platform, userId) — no cross-user leak', async () => {
    const memory = makeMemory({
      'qq/u1': { content: 'mine', last_updated_at: 10 },
      'qq/u2': { content: 'theirs', last_updated_at: 20 },
    })
    expect((await runReadUserMemory(memory, 'qq', 'u1')).text).toBe('mine')
    expect((await runReadUserMemory(memory, 'qq', 'u2')).text).toBe('theirs')
    expect((await runReadUserMemory(memory, 'discord', 'u1')).text).toBe(
      '(暂无记录)'
    )
  })

  it('appends usage stats when hardLimit is provided', async () => {
    const memory = makeMemory({
      'qq/u1': { content: '喜欢吃热干面', last_updated_at: 100 }, // 18 bytes UTF-8
    })
    const out = await runReadUserMemory(memory, 'qq', 'u1', {
      hardLimit: 3300,
    })
    expect(out.text).toMatch(/^喜欢吃热干面/)
    expect(out.text).toMatch(/已用 18 \/ 3300 字节/)
    expect(out.text).toMatch(/约 1% 配额/)
  })

  it('does not append usage stats for empty memory', async () => {
    const memory = makeMemory({
      'qq/u1': { content: '', last_updated_at: 0 },
    })
    const out = await runReadUserMemory(memory, 'qq', 'u1', {
      hardLimit: 3300,
    })
    expect(out.text).toBe('(暂无记录)')
  })

  it('strips trailing whitespace from content before appending stats', async () => {
    const memory = makeMemory({
      'qq/u1': { content: 'a\n\n\n', last_updated_at: 1 },
    })
    const out = await runReadUserMemory(memory, 'qq', 'u1', {
      hardLimit: 100,
    })
    expect(out.text).toBe('a\n\n(已用 1 / 100 字节，约 1% 配额)')
  })
})

describe('runSaveUserMemory', () => {
  // One fake record per tier, keyed by tier.
  const makeDeps = (
    over: {
      isDirect?: boolean
      updatedAt?: Partial<Record<MemoryTier, number>>
      hardLimit?: number
    } = {}
  ) => {
    const writes: Array<{ tier: MemoryTier; content: string }> = []
    return {
      writes,
      deps: {
        isDirect: over.isDirect ?? true,
        owners: {
          private: { name: '小鱼', uid: '1' },
          shared: { name: '小鱼', uid: '1' },
          group: { name: '测试群', uid: 'G1' },
        },
        getUpdatedAt: async (tier: MemoryTier) => over.updatedAt?.[tier] ?? 0,
        write: async (tier: MemoryTier, content: string) => {
          writes.push({ tier, content })
        },
        hardLimits: {
          private: over.hardLimit ?? 3300,
          shared: over.hardLimit ?? 3300,
          group: over.hardLimit ?? 3300,
        },
      },
    }
  }

  const fresh = (
    read: MemoryTier[] = [],
    over: Partial<MemoryToolState> = {}
  ): MemoryToolState => {
    const s = getMemoryToolState({})
    for (const tier of read) s[tier].hasRead = true
    return Object.assign(s, over)
  }

  it('refuses the private record outside a DM', async () => {
    const { writes, deps } = makeDeps({ isDirect: false })
    const out = await runSaveUserMemory(
      { tier: 'private', content: 'x' },
      fresh(['private', 'shared']),
      deps
    )
    expect(out).toMatch(/^Error: 私密记录只能在私聊里改/)
    expect(writes).toEqual([])
  })

  it('writes the shared record in a group', async () => {
    const { writes, deps } = makeDeps({ isDirect: false })
    const out = await runSaveUserMemory(
      { tier: 'shared', content: 'x' },
      fresh(['shared']),
      deps
    )
    expect(out).toBe('OK: 已更新 小鱼（uid 1）的共享记录（1 字节）。')
    expect(writes).toEqual([{ tier: 'shared', content: 'x' }])
  })

  it('refuses any write once someone else spoke in the turn', async () => {
    const { writes, deps } = makeDeps({ isDirect: false })
    const out = await runSaveUserMemory(
      { tier: 'shared', content: 'x' },
      fresh(['shared'], { othersSpoke: true }),
      deps
    )
    expect(out).toMatch(/有别人的消息/)
    expect(writes).toEqual([])
  })

  it('refuses the group memory in a DM', async () => {
    const { writes, deps } = makeDeps({ isDirect: true })
    const out = await runSaveUserMemory(
      { tier: 'group', content: 'x' },
      fresh(['group']),
      deps
    )
    expect(out).toMatch(/^Error: 群记忆只能在群里改/)
    expect(writes).toEqual([])
  })

  it('writes the group memory even when others spoke in the turn', async () => {
    const { writes, deps } = makeDeps({ isDirect: false })
    const out = await runSaveUserMemory(
      { tier: 'group', content: 'x' },
      fresh(['group'], { othersSpoke: true }),
      deps
    )
    expect(out).toBe('OK: 已更新 测试群（群 G1）的群记忆（1 字节）。')
    expect(writes).toEqual([{ tier: 'group', content: 'x' }])
  })

  it('rejects an unknown tier', async () => {
    const { writes, deps } = makeDeps()
    const out = await runSaveUserMemory(
      { tier: 'public' as any, content: 'x' },
      fresh(['private', 'shared']),
      deps
    )
    expect(out).toMatch(/"tier" must be/)
    expect(writes).toEqual([])
  })

  it('requires reading the same tier first', async () => {
    const { writes, deps } = makeDeps()
    const out = await runSaveUserMemory(
      { tier: 'private', content: 'x' },
      fresh(['shared']),
      deps
    )
    expect(out).toMatch(/^Error: please call read_user_memory first/)
    expect(writes).toEqual([])
  })

  it('allows one save per tier per turn', async () => {
    const { writes, deps } = makeDeps()
    const state = fresh(['private', 'shared'])
    await runSaveUserMemory({ tier: 'private', content: 'a' }, state, deps)
    await runSaveUserMemory({ tier: 'shared', content: 'b' }, state, deps)
    const again = await runSaveUserMemory({ tier: 'private', content: 'c' }, state, deps)
    expect(again).toMatch(/already saved in this turn/)
    expect(writes).toEqual([
      { tier: 'private', content: 'a' },
      { tier: 'shared', content: 'b' },
    ])
  })

  it('rejects empty / whitespace content', async () => {
    const { writes, deps } = makeDeps()
    const out = await runSaveUserMemory(
      { tier: 'private', content: '   \n\t  ' },
      fresh(['private']),
      deps
    )
    expect(out).toMatch(/empty or whitespace/)
    expect(writes).toEqual([])
  })

  it('rejects content exceeding the hard limit', async () => {
    const { writes, deps } = makeDeps({ hardLimit: 3300 })
    const out = await runSaveUserMemory(
      { tier: 'shared', content: 'x'.repeat(4000) },
      fresh(['shared']),
      deps
    )
    expect(out).toMatch(/exceeds the shared hard limit 3300/)
    expect(writes).toEqual([])
  })

  it('rejects and forces a re-read when the record changed after the read', async () => {
    const { writes, deps } = makeDeps({ updatedAt: { private: 200 } })
    const state = fresh(['private'])
    state.private.lastSeenUpdatedAt = 100
    const out = await runSaveUserMemory(
      { tier: 'private', content: 'new' },
      state,
      deps
    )
    expect(out).toMatch(/modified after your last read/)
    expect(writes).toEqual([])
    expect(state.private.hasRead).toBe(false)
    expect(state.private.lastSeenUpdatedAt).toBe(0)
  })

  it('rejects malformed input', async () => {
    const { deps } = makeDeps()
    const out = await runSaveUserMemory(
      { tier: 'private' },
      fresh(['private']),
      deps
    )
    expect(out).toMatch(/missing required field/)
  })
})

describe('getMemoryToolState', () => {
  it('initializes per-tier state on first access and shares it across calls', () => {
    const ts: Record<string, unknown> = {}
    const a = getMemoryToolState(ts)
    expect(a.private).toEqual({ hasRead: false, lastSeenUpdatedAt: 0, saved: false })
    expect(a.shared).toEqual({ hasRead: false, lastSeenUpdatedAt: 0, saved: false })
    expect(a.group).toEqual({ hasRead: false, lastSeenUpdatedAt: 0, saved: false })
    expect(a.othersSpoke).toBe(false)
    a.shared.hasRead = true
    expect(getMemoryToolState(ts)).toBe(a)
  })
})

describe('runWebSearch', () => {
  const makeClient = (resp: WebSearchResponse): WebSearchClient => ({
    async search() {
      return resp
    },
  })

  const failingClient = (msg = 'boom'): WebSearchClient => ({
    async search() {
      throw new Error(msg)
    },
  })

  const freshState = (
    overrides: Partial<WebToolsState> = {}
  ): WebToolsState => ({
    searchCallCount: 0,
    extractCallCount: 0,
    ...overrides,
  })

  const sampleResults: WebSearchResponse = {
    results: [
      {
        title: 'Example One',
        url: 'https://example.com/a',
        content: 'first snippet',
        score: 0.9,
      },
      {
        title: 'Example Two',
        url: 'https://example.com/b',
        content: 'second snippet',
      },
    ],
  }

  it('rejects empty / missing query without burning the budget', async () => {
    const c = makeClient(sampleResults)
    const state = freshState()
    expect(await runWebSearch(undefined, c, state)).toMatch(
      /missing required field/
    )
    expect(await runWebSearch({ query: '' }, c, state)).toMatch(
      /missing required/
    )
    expect(await runWebSearch({ query: '   \n  ' }, c, state)).toMatch(
      /missing required/
    )
    expect(state.searchCallCount).toBe(0)
  })

  it('formats results with title, URL and content', async () => {
    const out = await runWebSearch(
      { query: 'foo' },
      makeClient(sampleResults),
      freshState()
    )
    expect(out).toContain('# 搜索结果："foo"')
    expect(out).toContain('## 1. Example One')
    expect(out).toContain('URL: https://example.com/a')
    expect(out).toContain('first snippet')
    expect(out).toContain('## 2. Example Two')
    expect(out).toContain('URL: https://example.com/b')
    expect(out).toContain('second snippet')
  })

  it('includes the engine answer when provided', async () => {
    const out = await runWebSearch(
      { query: 'foo' },
      makeClient({ ...sampleResults, answer: 'short summary' }),
      freshState()
    )
    expect(out).toContain('**摘要**：short summary')
  })

  it('handles empty results gracefully and still increments call count', async () => {
    const state = freshState()
    const out = await runWebSearch(
      { query: 'no hits' },
      makeClient({ results: [] }),
      state
    )
    expect(out).toMatch(/没有搜到.*"no hits"/)
    expect(state.searchCallCount).toBe(1)
  })

  it('returns Error string when client throws (still increments)', async () => {
    const state = freshState()
    const out = await runWebSearch(
      { query: 'foo' },
      failingClient('network down'),
      state
    )
    expect(out).toMatch(/^Error: web search failed: network down/)
    expect(state.searchCallCount).toBe(1)
  })

  it('clamps max_results to the configured cap', async () => {
    let received = 0
    const client: WebSearchClient = {
      async search(input) {
        received = input.maxResults
        return { results: [] }
      },
    }
    await runWebSearch({ query: 'q', max_results: 999 }, client, freshState(), {
      maxResultsCap: 10,
    })
    expect(received).toBe(10)
  })

  it('falls back to defaultMaxResults when not provided / invalid', async () => {
    let received = 0
    const client: WebSearchClient = {
      async search(input) {
        received = input.maxResults
        return { results: [] }
      },
    }
    await runWebSearch({ query: 'q' }, client, freshState(), {
      defaultMaxResults: 7,
    })
    expect(received).toBe(7)
    await runWebSearch({ query: 'q', max_results: 0 }, client, freshState(), {
      defaultMaxResults: 7,
    })
    expect(received).toBe(7)
    await runWebSearch(
      { query: 'q', max_results: Number.NaN as any },
      client,
      freshState(),
      { defaultMaxResults: 7 }
    )
    expect(received).toBe(7)
  })

  it('honors a valid in-range max_results', async () => {
    let received = 0
    const client: WebSearchClient = {
      async search(input) {
        received = input.maxResults
        return { results: [] }
      },
    }
    await runWebSearch({ query: 'q', max_results: 3 }, client, freshState(), {
      defaultMaxResults: 5,
      maxResultsCap: 10,
    })
    expect(received).toBe(3)
  })

  it('trims the query before passing to the client', async () => {
    let received = ''
    const client: WebSearchClient = {
      async search(input) {
        received = input.query
        return { results: [] }
      },
    }
    await runWebSearch({ query: '  hello world  ' }, client, freshState())
    expect(received).toBe('hello world')
  })

  it('rejects further calls past the per-turn cap', async () => {
    const state = freshState({ searchCallCount: 3 })
    let calls = 0
    const client: WebSearchClient = {
      async search() {
        calls++
        return { results: [] }
      },
    }
    const out = await runWebSearch({ query: 'q' }, client, state, {
      maxCallsPerTurn: 3,
    })
    expect(out).toMatch(/已经调用 3 次.*上限 3/)
    expect(calls).toBe(0) // didn't hit the API
    expect(state.searchCallCount).toBe(3) // didn't increment past the cap either
  })

  it('lets a fresh-state agent reach the cap exactly', async () => {
    const state = freshState()
    const client = makeClient(sampleResults)
    for (let i = 0; i < 3; i++) {
      const out = await runWebSearch({ query: `q${i}` }, client, state, {
        maxCallsPerTurn: 3,
      })
      expect(out).not.toMatch(/^Error/)
    }
    expect(state.searchCallCount).toBe(3)
    const out = await runWebSearch({ query: 'q4' }, client, state, {
      maxCallsPerTurn: 3,
    })
    expect(out).toMatch(/^Error: web_search/)
  })

  it('appends remaining-budget hint when below cap', async () => {
    const state = freshState()
    const out = await runWebSearch(
      { query: 'q' },
      makeClient(sampleResults),
      state,
      { maxCallsPerTurn: 3 }
    )
    expect(out).toMatch(/本轮还可再 search 2 次/)
  })

  it('appends quota-used-up hint at last allowed call', async () => {
    const state = freshState({ searchCallCount: 2 })
    const out = await runWebSearch(
      { query: 'q' },
      makeClient(sampleResults),
      state,
      { maxCallsPerTurn: 3 }
    )
    expect(out).toMatch(/本轮 search 配额已用完/)
  })
})

describe('WEB_SEARCH_TOOL definition', () => {
  it('declares query as required and constrains max_results', () => {
    expect(WEB_SEARCH_TOOL.name).toBe('web_search')
    expect(WEB_SEARCH_TOOL.parameters.required).toEqual(['query'])
    const props = WEB_SEARCH_TOOL.parameters.properties
    expect(props.query.type).toBe('string')
    expect(props.max_results.type).toBe('integer')
    expect(props.max_results.minimum).toBe(1)
    expect(props.max_results.maximum).toBe(10)
  })

  it('teaches when to use vs not use, and points to extract_webpages', () => {
    expect(WEB_SEARCH_TOOL.description).toMatch(/何时调|何时别调|什么时候调/)
    expect(WEB_SEARCH_TOOL.description).toMatch(/execute_koishi_command/)
    expect(WEB_SEARCH_TOOL.description).toMatch(/extract_webpages/)
    expect(WEB_SEARCH_TOOL.description).toMatch(/3 次/)
  })
})

describe('runWebExtract', () => {
  const sampleResp: WebExtractResponse = {
    results: [
      {
        url: 'https://example.com/a',
        title: 'Page A',
        content: 'page A body',
      },
      {
        url: 'https://example.com/b',
        content: 'page B body',
      },
    ],
    failed: [{ url: 'https://example.com/dead', error: '404' }],
  }

  const makeClient = (resp: WebExtractResponse): WebExtractClient => ({
    async extract() {
      return resp
    },
  })

  const freshState = (
    overrides: Partial<WebToolsState> = {}
  ): WebToolsState => ({
    searchCallCount: 0,
    extractCallCount: 0,
    ...overrides,
  })

  it('rejects missing / non-array urls', async () => {
    const c = makeClient(sampleResp)
    expect(await runWebExtract(undefined, c, freshState())).toMatch(
      /missing required field "urls"/
    )
    expect(
      await runWebExtract({ urls: 'not-array' as any }, c, freshState())
    ).toMatch(/missing required field "urls"/)
  })

  it('rejects empty / all-blank urls array', async () => {
    const c = makeClient(sampleResp)
    expect(await runWebExtract({ urls: [] }, c, freshState())).toMatch(
      /empty after trimming/
    )
    expect(
      await runWebExtract({ urls: ['', '  ', '\n'] }, c, freshState())
    ).toMatch(/empty after trimming/)
  })

  it('rejects too many URLs', async () => {
    const urls = Array.from({ length: 6 }, (_, i) => `https://e.com/${i}`)
    const out = await runWebExtract({ urls }, makeClient(sampleResp), freshState(), {
      maxUrlsPerCall: 5,
    })
    expect(out).toMatch(/too many URLs.*cap is 5/)
  })

  it('formats successful results + failed urls together', async () => {
    const out = await runWebExtract(
      { urls: ['https://example.com/a', 'https://example.com/b'] },
      makeClient(sampleResp),
      freshState()
    )
    expect(out).toContain('## 1. Page A')
    expect(out).toContain('URL: https://example.com/a')
    expect(out).toContain('page A body')
    expect(out).toContain('## 2. https://example.com/b')
    expect(out).toContain('page B body')
    expect(out).toContain('## 抓取失败的 URL')
    expect(out).toContain('https://example.com/dead — 404')
  })

  it('returns Error string when client throws (still increments)', async () => {
    const state = freshState()
    const client: WebExtractClient = {
      async extract() {
        throw new Error('rate limit')
      },
    }
    const out = await runWebExtract(
      { urls: ['https://example.com/a'] },
      client,
      state
    )
    expect(out).toMatch(/^Error: web extract failed: rate limit/)
    expect(state.extractCallCount).toBe(1)
  })

  it('rejects further calls past the per-turn cap', async () => {
    const state = freshState({ extractCallCount: 2 })
    let calls = 0
    const client: WebExtractClient = {
      async extract() {
        calls++
        return { results: [], failed: [] }
      },
    }
    const out = await runWebExtract(
      { urls: ['https://example.com/a'] },
      client,
      state,
      { maxCallsPerTurn: 2 }
    )
    expect(out).toMatch(/已经调用 2 次.*上限 2/)
    expect(calls).toBe(0)
    expect(state.extractCallCount).toBe(2)
  })

  it('trims and filters non-string entries before sending', async () => {
    let received: string[] = []
    const client: WebExtractClient = {
      async extract(urls) {
        received = urls
        return { results: [], failed: [] }
      },
    }
    await runWebExtract(
      { urls: ['  https://x.com  ', 42 as any, '', 'https://y.com'] },
      client,
      freshState()
    )
    expect(received).toEqual(['https://x.com', 'https://y.com'])
  })
})

describe('EXTRACT_WEBPAGES_TOOL definition', () => {
  it('requires urls and constrains array size', () => {
    expect(EXTRACT_WEBPAGES_TOOL.name).toBe('extract_webpages')
    expect(EXTRACT_WEBPAGES_TOOL.parameters.required).toEqual(['urls'])
    const urls = EXTRACT_WEBPAGES_TOOL.parameters.properties.urls
    expect(urls.type).toBe('array')
    expect(urls.minItems).toBe(1)
    expect(urls.maxItems).toBe(5)
  })

  it('teaches batch usage and per-turn cap', () => {
    expect(EXTRACT_WEBPAGES_TOOL.description).toMatch(/一次调用|batch|一次性/)
    expect(EXTRACT_WEBPAGES_TOOL.description).toMatch(/2 次|最多 2/)
    expect(EXTRACT_WEBPAGES_TOOL.description).toMatch(/web_search/)
  })
})

describe('getWebToolsState', () => {
  it('initializes counts to zero on first access and shares thereafter', () => {
    const ts: Record<string, unknown> = {}
    const a = getWebToolsState(ts)
    expect(a).toEqual({ searchCallCount: 0, extractCallCount: 0 })
    a.searchCallCount = 2
    const b = getWebToolsState(ts)
    expect(b).toBe(a)
    expect(b.searchCallCount).toBe(2)
  })
})

describe('buildSaveUserMemoryTool', () => {
  it('bakes hardLimit into description', () => {
    const def = buildSaveUserMemoryTool({ private: 3300, shared: 1100, group: 2200 })
    expect(def.name).toBe('save_user_memory')
    expect(def.description).toContain("private 3300 字节，shared 1100 字节，group 2200 字节")
    expect(def.description).toContain('read_user_memory')
  })

  it('teaches declarative-not-imperative phrasing', () => {
    const def = buildSaveUserMemoryTool({ private: 3300, shared: 1100, group: 2200 })
    expect(def.description).toMatch(/声明[性式]|不要[写用]命令/)
  })

  it('forbids recording user requests to alter SILI persona', () => {
    const def = buildSaveUserMemoryTool({ private: 3300, shared: 1100, group: 2200 })
    expect(def.description).toMatch(/SILI.*人设|SILI 自[己身]|个人设定/)
  })

  it('mentions date-stamping for time-sensitive entries', () => {
    const def = buildSaveUserMemoryTool({ private: 3300, shared: 1100, group: 2200 })
    expect(def.description).toMatch(/YYYY-MM-DD|turn_context|chat_info/)
  })
})
