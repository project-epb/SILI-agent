/**
 * AI Chat Plugin - make chat bot great again!
 * @author dragon-fish
 * @license MIT
 */
import { Context, Time } from 'koishi'

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import BasePlugin from '~/_boilerplate'

import type { ClientOptions as AnthropicClientOptions } from '@anthropic-ai/sdk'
import { Inject } from 'cordis'
import type { ClientOptions } from 'openai'

import AdminCommands from './commands/admin'
import ChatCommand from './commands/chat'
import { ChatCompletionUsage, LLMProviderBase } from './providers/_base'
import { AnthropicProvider } from './providers/anthropic'
import { CopilotProvider } from './providers/copilot'
import { OpenAIProvider } from './providers/openai'
import { ResponsesProvider } from './providers/responses'
import { ActiveChatRegistry } from './services/active-chats'
import { ChatHistoryService } from './services/chat-history'
import { CommandCatalogService } from './services/command-catalog'
import { resolveConversationScope } from './services/conversation-scope'
import { DeepSeekSearchClient } from './services/deepseek-search-client'
import type { TurnStatus } from './services/history-filter'
import { IdleCompactor } from './services/idle-compactor'
import { ImageReferenceCache } from './services/image-cache'
import { encodeImage } from './services/image-encode'
import { ImageStore } from './services/image-store'
import { rewriteInboundImages } from './utils/inbound-images'
import { MemoryStore } from './services/memory'
import {
  PROVIDER_FILES_CLEANUP_MS,
  ProviderFiles,
  extendProviderFileTable,
} from './services/provider-files'
import { MemoryForkScheduler } from './services/memory-fork-scheduler'
import type { MemorySnapshotSource } from './services/memory-snapshot'
import { SessionManager } from './services/session-manager'
import { MemoryRecordStore } from './services/shared-memory'
import { SummaryCompactor } from './services/summary-compactor'
import { SystemPromptBuilder } from './services/system-prompt'
import { TavilySearchClient } from './services/tavily-client'
import { TurnAllocator } from './services/turn-allocator'
import { migrateTurnNumbers } from './services/turn-migration'
import {
  EXTRACT_WEBPAGES_TOOL,
  type MemoryOwner,
  type MemoryTier,
  READ_USER_MEMORY_TOOL,
  ToolRegistry,
  WEB_SEARCH_TOOL,
  buildReadChannelHistoryHandler,
  buildSaveUserMemoryTool,
  buildStoredChannelHistoryHandler,
  viewImageHandler,
  executeKoishiCommandHandler,
  getMemoryToolState,
  getWebToolsState,
  readableTiers,
  renderMemoryBlock,
  runReadUserMemory,
  runSaveUserMemory,
  runWebExtract,
  runWebSearch,
} from './tools'
import { type CommandCatalogEntry } from './utils/command-catalog'

declare module 'koishi' {
  export interface Tables {
    openai_chat: OpenAIConversationLog
  }
  export interface User {
    openai_last_conversation_id: string
  }
  export interface Channel {
    /** Current conversation of a group-shared session (see conversation-scope). */
    openai_last_conversation_id: string
  }
  interface Context {
    llm: PluginLLM
  }
}

interface OpenAIConversationLog {
  id: number
  conversation_id: string
  conversation_owner: number
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  reasoning_content: string
  tool_calls?: string // JSON 序列化的 ToolCall[]
  tool_call_id?: string // tool 角色填
  tool_name?: string // tool 角色填，便于日志
  usage?: ChatCompletionUsage
  model?: string
  time: number
  /**
   * Per-conversation monotonic turn counter (1-based). All rows produced
   * by one chat invocation share this value. Sorted on for history
   * reconstruction together with `intra_turn_seq` — replaces `time` as
   * the primary ordering key, since `time` is wall-clock and races on
   * interrupt boundaries / tool latency. `time` is kept as a debug-only
   * timestamp.
   */
  turn_number: number
  /**
   * Order within a turn: user row is always 0; assistant/tool rows take
   * 1, 2, 3, ... in the order the chat handler writes them.
   */
  intra_turn_seq: number
  /** User rows only: how the turn ended. See history-filter `TurnStatus`. */
  turn_status?: TurnStatus
  /** User rows only: why a failed turn failed. For people; never sent. */
  turn_error?: string
  /** User and tool rows: images sent with the row (see providers/images.ts). */
  images?: string[]
}

interface ProviderCommon {
  name: string
  model?: string
  maxTokens?: number
  /** The models read images; otherwise images become a note. */
  vision?: boolean
  /** Send images as Files API file_ids (responses only). */
  nativeFiles?: boolean
  /** Total bytes we keep uploaded to this provider; LRU beyond it. */
  nativeFilesMaxBytes?: number
}

export type ProviderConfig = ProviderCommon &
  (
    | { type: 'openai' | 'copilot' | 'responses'; options: ClientOptions }
    | { type: 'anthropic'; options: AnthropicClientOptions }
  )

export interface Config {
  providers: ProviderConfig[]
  model?: string
  /**
   * Summary compaction. Every turn loads the conversation's full history
   * since the last compaction; compaction keeps it in check. The context
   * size is the prompt tokens of the conversation's latest model call.
   *
   * - compactAtContextTokens: compact before the next turn once the
   *   context reaches this. 0 disables it.
   * - idleCompactAfterMs / idleCompactMinTokens: a background pass
   *   compacts a current conversation idle that long whose context is at
   *   least that big. A provider's prompt cache can outlive a short idle
   *   spell (DeepSeek's lasts hours), so compacting early only throws a
   *   warm cache away.
   */
  compactAtContextTokens?: number
  idleCompactAfterMs?: number
  idleCompactMinTokens?: number
  /**
   * 是否把 user 消息以「chat_info 包裹后的完整 envelope」形式入库。
   * 默认 true。开启后，下一轮 chat 拼 prompt 时上一条 user 消息的
   * 字节会与上一轮真正发给 provider 的字节一致，prefix cache 在那
   * 一位也能命中（否则裸文本 vs envelope 必然 miss）。
   *
   * Interrupt notice block 不会被持久化（仅当前轮指令，留到历史里
   * 会误导未来对话）。
   */
  persistWrappedUserMessage?: boolean
  maxTokens?: number
  systemPrompt?: Partial<{
    default: string
    [key: string]: string
  }>
  modelAliases?: Record<string, string>

  // Agent 改造新增
  enableAgent?: boolean
  maxToolIterations?: number
  /**
   * Send a "[正在执行: xxx]" notice before each tool call. Verbose by nature —
   * off by default, so an ordinary chat is not interleaved with tool chatter.
   * Turn on only when debugging what the agent is doing.
   */
  showToolCallNotice?: boolean
  /**
   * Remind the model to say what it is doing after this long without
   * visible text during tool calls; 0 disables this trigger. See utils/progress-nudge.
   */
  progressNudgeAfterMs?: number
  /** Also remind after this many tool calls without visible text; 0 disables. */
  progressNudgeAfterToolCalls?: number
  /**
   * DeepSeek "DSML leak" workaround (see utils/dsml-leak.ts): when the model
   * dumps its tool-call markup as plain content, re-send the same payload
   * this many times before giving up (then a graceful fallback reply shows).
   * Re-rolls don't consume the tool-iteration budget. 0 disables. Default 2.
   */
  dsmlLeakMaxRetries?: number
  memoryByteLimit?: number
  /** Soft byte limit of a user's shared record (hard = ×1.1). Default 3000. */
  sharedMemoryByteLimit?: number
  /** Soft byte limit of a group's memory (hard = ×1.1). Default 3000. */
  groupMemoryByteLimit?: number
  memoryUpdateInterval?: number
  memoryForkMaxRetries?: number
  /**
   * Max characters of a quote-replied message injected as `<quoted_message>`.
   * The block is persisted with the user row, so an unbounded quote would bloat
   * both the prompt and history. `0` = no limit. Default 1000.
   */
  quotedMessageMaxLength?: number
  /**
   * Idle timeout (ms) for a chat session. After this many ms without a new
   * user message, the next message rotates to a fresh conversation_id —
   * primarily a length cap on chat history, since system prompt is now
   * derived per-process and no longer frozen per-session. 0 disables expiry.
   */
  sessionIdleTimeoutMs?: number
  /**
   * Override the model used for memory fork tasks (e.g. summarisation).
   * Format: "providerName:modelName" or "providerName#modelName" or just "modelName".
   * If unset or unresolvable, falls back to the default provider/model.
   */
  memoryModel?: string
  /** Total disk usage cap for the inline-image cache (bytes). Default 500MB. */
  imageCacheMaxBytes?: number
  /** Per-file TTL for the inline-image cache (ms). Default 4h. */
  imageCacheTtlMs?: number
  /** Max bytes per image; oversized images skip cache + show placeholder. Default 8MB. */
  imageCacheMaxImageBytes?: number
  /**
   * `web_search` + `extract_webpages` tools, served by the chosen backend.
   * Without this config, or without the chosen backend's key, the tools are
   * not registered and the agent has no web-search capability (the
   * provider-side `enableSearch` flag is unaffected).
   */
  webSearch?: {
    backend: 'deepseek' | 'tavily'
    /** DeepSeek Search & Fetch; billed to the same account as its chat models. */
    deepseek?: { apiKey: string }
    tavily?: {
      apiKey: string
      searchDepth?: 'basic' | 'advanced' | 'fast' | 'ultra-fast'
      topic?: 'general' | 'news' | 'finance'
      /** Extract depth: `basic` is fast, `advanced` more thorough. Default basic. */
      extractDepth?: 'basic' | 'advanced'
    }
    /** Default result count if the agent doesn't pass max_results. Default 5. */
    defaultMaxResults?: number
    /** Hard cap for max_results (agent requests above this are clamped). Default 10. */
    maxResultsCap?: number
    /** Per-request timeout in seconds. Default 15. */
    timeoutSeconds?: number
    /** Hard cap for URLs per single extract call. Default 5. */
    maxExtractUrlsPerCall?: number
    /** Per-turn cap for `web_search` tool calls. Default 3. */
    maxSearchCallsPerTurn?: number
    /** Per-turn cap for `extract_webpages` tool calls. Default 2. */
    maxExtractCallsPerTurn?: number
  }
}
export declare const Config: Config

export default class PluginLLM extends BasePlugin<Config> {
  static inject: Inject = {
    database: { required: true },
    html: { required: false },
    channelMessageHistory: { required: false },
  }

  readonly providers: Map<string, LLMProviderBase> = new Map()

  get defaultProvider(): LLMProviderBase {
    const first = this.providers.values().next().value
    if (!first) throw new Error('No LLM provider configured')
    return first
  }

  useProvider(name: string): LLMProviderBase {
    const p = this.providers.get(name)
    if (!p) throw new Error(`LLM provider "${name}" not found`)
    return p
  }

  readonly MODEL_ALIASES: Record<string, string> = {}
  /** Private records: read and written in DMs only. */
  readonly memory: MemoryStore = new MemoryStore(this.ctx)
  /** Shared records: a user's public facts, read and written in any group. */
  readonly sharedMemory = new MemoryRecordStore(
    this.ctx,
    'openai_user_shared_memory'
  )
  /** Group memories: one per group, read and written in that group only. */
  readonly groupMemory = new MemoryRecordStore(this.ctx, 'openai_group_memory')
  readonly sessions: SessionManager = new SessionManager(this.ctx)
  readonly tools: ToolRegistry = new ToolRegistry()
  /** Images the model looks at, by content hash (see services/image-store). */
  readonly images = new ImageStore({
    dir: resolve(this.ctx.baseDir, 'data', 'llm', 'images'),
    ttlMs: 30 * Time.day,
    maxBytes: 2 * 1024 ** 3,
    maxImageBytes: 20 * 1024 ** 2,
    encode: encodeImage,
    fetch: async (url) => new Uint8Array((await this.ctx.http.file(url)).data),
  })
  readonly imageRefs: ImageReferenceCache = new ImageReferenceCache({
    dir: resolve(this.ctx.baseDir, 'data', 'llm', 'image-cache'),
    maxBytes: this.config.imageCacheMaxBytes,
    ttlMs: this.config.imageCacheTtlMs,
    maxImageBytes: this.config.imageCacheMaxImageBytes,
  })
  readonly systemPrompt: SystemPromptBuilder = new SystemPromptBuilder(
    () => this.config.systemPrompt.default ?? '',
    this.ctx,
    PluginLLM.readPromptFile('IM-voice.prompt.md')
  )
  readonly chatHistory: ChatHistoryService = new ChatHistoryService(this.ctx)
  readonly activeChats: ActiveChatRegistry = new ActiveChatRegistry(this.logger)
  readonly catalog: CommandCatalogService = new CommandCatalogService(
    this.ctx,
    this.logger
  )
  readonly memoryFork: MemoryForkScheduler = new MemoryForkScheduler(this)
  readonly turns: TurnAllocator = new TurnAllocator(this.ctx)
  // Summary compactor — instantiated post-construct so it can read the
  // resolved config (`compactAtContextTokens`).
  summary!: SummaryCompactor

  constructor(ctx: Context, config: Config) {
    const defaultConfigs: Partial<Config> = {
      model: 'gpt-4o-mini',
      maxTokens: 8192,
      compactAtContextTokens: 256_000,
      idleCompactAfterMs: 6 * 60 * 60 * 1000, // 6 hours
      idleCompactMinTokens: 24_000,
      persistWrappedUserMessage: true,
      enableAgent: true,
      maxToolIterations: 5,
      showToolCallNotice: false,
      progressNudgeAfterMs: 60 * 1000,
      progressNudgeAfterToolCalls: 5,
      dsmlLeakMaxRetries: 2,
      memoryByteLimit: 3000,
      sharedMemoryByteLimit: 3000,
      groupMemoryByteLimit: 3000,
      memoryUpdateInterval: 10,
      memoryForkMaxRetries: 3,
      quotedMessageMaxLength: 1000,
      sessionIdleTimeoutMs: 3 * 24 * 60 * 60 * 1000, // 3 days
      systemPrompt: {
        default:
          process.env.KOISHI_ENV === 'dev'
            ? PluginLLM.readPromptFile('Noir-v2.prompt.md')
            : PluginLLM.readPromptFile('SILI-v7.prompt.md'),
      },
    }
    config = {
      ...defaultConfigs,
      ...config,
      systemPrompt: {
        ...defaultConfigs.systemPrompt,
        ...config.systemPrompt,
      },
    }
    super(ctx, config, 'llm')

    this.summary = new SummaryCompactor(
      this.ctx,
      this.logger,
      this.chatHistory,
      this.sessions,
      this.turns,
      { maxContextTokens: config.compactAtContextTokens ?? 256_000 }
    )
    const idleCompactor = new IdleCompactor({
      ctx: this.ctx,
      logger: this.logger,
      history: this.chatHistory,
      summary: this.summary,
      activeChats: this.activeChats,
      idleMs: config.idleCompactAfterMs ?? 6 * 60 * 60 * 1000,
      minTokens: config.idleCompactMinTokens ?? 24_000,
      memorySources: (row, group) => {
        // A session row does not record whether it is a DM; outside a
        // group's shared conversation it almost always is (v5 serves QQ DMs
        // and groups). Group rows key on the channel, user rows on the uid.
        const owner = { name: row.user_id, uid: row.user_id }
        return this.memorySources(
          row.platform,
          { private: owner, shared: owner, group: owner },
          group ? ['group'] : ['private', 'shared']
        )
      },
      turnSetup: () => ({
        provider: this.defaultProvider,
        model: config.providers[0]?.model || config.model || 'gpt-4o-mini',
        systemPrompt: this.systemPrompt.get(this.catalog.getOrRefresh()),
      }),
    })
    this.ctx.on('ready', () => {
      this.ctx.setInterval(() => idleCompactor.run(), 10 * Time.minute)
      // Build the prompt once after late plugins have loaded, so every
      // process logs its prefix hash (SystemPromptBuilder) for comparison.
      this.ctx.setTimeout(() => {
        this.systemPrompt.get(this.catalog.getOrRefresh())
        const tools = JSON.stringify(this.tools.listDefinitions())
        this.logger.info(
          '[llm] tool list: %d chars, sha256 %s',
          tools.length,
          createHash('sha256').update(tools).digest('hex').slice(0, 16)
        )
      }, Time.minute)
    })

    extendProviderFileTable(ctx)
    const providerFiles: ProviderFiles[] = []
    for (const providerConfig of config.providers) {
      let provider: LLMProviderBase
      switch (providerConfig.type) {
        case 'openai':
          provider = new OpenAIProvider(providerConfig.options)
          break
        case 'responses': {
          const responses = new ResponsesProvider(providerConfig.options)
          if (providerConfig.nativeFiles) {
            responses.files = new ProviderFiles(
              ctx,
              providerConfig.name,
              responses.client,
              providerConfig.nativeFilesMaxBytes ?? 1024 ** 3
            )
            providerFiles.push(responses.files)
          }
          provider = responses
          break
        }
        case 'anthropic':
          provider = new AnthropicProvider(providerConfig.options)
          break
        case 'copilot':
          provider = new CopilotProvider(providerConfig.options)
          break
        default:
          this.logger.warn(
            `Unknown provider type: ${(providerConfig as any).type}`
          )
          continue
      }
      provider.vision = providerConfig.vision ?? false
      provider.imageSource = this.images
      this.providers.set(providerConfig.name, provider)
    }
    // Remote files are ours to clean up: few providers expire them.
    const cleanupProviderFiles = () => {
      for (const files of providerFiles)
        files
          .cleanup()
          .then((n) => n && this.logger.info('[files] deleted %d expired remote files', n))
          .catch((e) => this.logger.warn('[files] cleanup failed:', e))
    }
    ctx.on('ready', cleanupProviderFiles)
    ctx.setInterval(cleanupProviderFiles, PROVIDER_FILES_CLEANUP_MS)

    this.#initDatabase()
    // 顶层命令（仅声明 namespace，子命令由子插件注册）
    ctx.command('llm', 'Make ChatBot Great Again')
    // 子插件：每个负责一组命令，随父插件 dispose 自动卸载。
    ctx.plugin(AdminCommands)
    ctx.plugin(ChatCommand)
    if (config.modelAliases) {
      this.MODEL_ALIASES = config.modelAliases
    }

    // 注册内建工具
    this.tools.register(executeKoishiCommandHandler)
    // Each capability's standing rules as its own `<plugin>` section,
    // registered with its tools so a section never outlives them.
    const promptSection = (id: string, file: string) => {
      const text = PluginLLM.readPromptFile(file)
      this.ctx.on('llm/build-system-prompt', (registry) => registry.add(id, text))
    }
    promptSection('memory', 'memory.prompt.md')
    const hardLimits = () => ({
      private: this.getMemoryHardLimit('private'),
      shared: this.getMemoryHardLimit('shared'),
      group: this.getMemoryHardLimit('group'),
    })
    this.tools.register({
      definition: READ_USER_MEMORY_TOOL,
      execute: async (_args, { session, turnState }) => {
        const { platform } = this.resolveMemoryKey(session)
        const owners = this.memoryOwners(session)
        const state = getMemoryToolState(turnState)
        const blocks: string[] = []
        for (const tier of readableTiers(session.isDirect)) {
          const result = await runReadUserMemory(
            this.memoryStore(tier),
            platform,
            owners[tier].uid,
            { hardLimit: this.getMemoryHardLimit(tier) }
          )
          state[tier].hasRead = true
          state[tier].lastSeenUpdatedAt = result.lastUpdatedAt
          blocks.push(renderMemoryBlock(owners[tier], tier, result.text))
        }
        if (!session.isDirect)
          blocks.push('（这里是群聊：私密记录只能在私聊里读写。）')
        return blocks.join('\n\n')
      },
    })
    this.tools.register({
      definition: buildSaveUserMemoryTool(hardLimits()),
      execute: async (args, { ctx, session, turnState }) => {
        const { platform } = this.resolveMemoryKey(session)
        const owners = this.memoryOwners(session)
        const scope = resolveConversationScope(session)
        const conversationId = scope.conversationId
        if (!conversationId) {
          return 'Error: no active conversation. Skip this turn and try again on the next user message.'
        }
        // Same source of truth as the memory-fork scheduler: a private save
        // pushes `message_count_at_update` forward, deferring the next fork.
        const countUserMessages = async () => {
          const rows = await ctx.database.get(
            'openai_chat',
            {
              conversation_owner: scope.owner,
              conversation_id: conversationId,
              role: 'user',
            },
            { fields: ['id'] }
          )
          return rows?.length ?? 0
        }
        return runSaveUserMemory(args as any, getMemoryToolState(turnState), {
          isDirect: session.isDirect,
          owners,
          getUpdatedAt: async (tier) =>
            (await this.memoryStore(tier).getMeta(platform, owners[tier].uid))
              ?.last_updated_at ?? 0,
          write: async (tier, content) => {
            const key = owners[tier].uid
            if (tier !== 'private') {
              const store =
                tier === 'shared' ? this.sharedMemory : this.groupMemory
              return store.set(platform, key, content)
            }
            await this.memory.set(
              platform,
              key,
              content,
              await countUserMessages(),
              conversationId
            )
          },
          hardLimits: hardLimits(),
        })
      },
    })

    // 可选工具：web_search + extract_webpages（仅在所选后端配置了 key 时注册）
    const webSearch = config.webSearch
    const webClient = webSearch
      ? webSearch.backend === 'deepseek'
        ? webSearch.deepseek?.apiKey
          ? new DeepSeekSearchClient({
              apiKey: webSearch.deepseek.apiKey,
              timeoutSeconds: webSearch.timeoutSeconds,
            })
          : null
        : webSearch.tavily?.apiKey
          ? new TavilySearchClient({
              apiKey: webSearch.tavily.apiKey,
              searchDepth: webSearch.tavily.searchDepth,
              topic: webSearch.tavily.topic,
              timeoutSeconds: webSearch.timeoutSeconds,
              extractDepth: webSearch.tavily.extractDepth,
            })
          : null
      : null
    if (webSearch && !webClient) {
      this.logger.warn(
        `web search backend "${webSearch.backend}" has no API key; web_search is not registered`
      )
    }
    if (webSearch && webClient) {
      this.logger.info(`web search backend: ${webSearch.backend}`)
      promptSection('web-search', 'web-search.prompt.md')
      this.tools.register({
        definition: WEB_SEARCH_TOOL,
        execute: async (args, { turnState }) =>
          runWebSearch(args as any, webClient, getWebToolsState(turnState), {
            defaultMaxResults: webSearch.defaultMaxResults,
            maxResultsCap: webSearch.maxResultsCap,
            maxCallsPerTurn: webSearch.maxSearchCallsPerTurn,
          }),
      })
      this.tools.register({
        definition: EXTRACT_WEBPAGES_TOOL,
        execute: async (args, { turnState }) =>
          runWebExtract(args as any, webClient, getWebToolsState(turnState), {
            maxUrlsPerCall: webSearch.maxExtractUrlsPerCall,
            maxCallsPerTurn: webSearch.maxExtractCallsPerTurn,
          }),
      })
    }

    promptSection('image', 'image.prompt.md')
    this.tools.register(viewImageHandler)

    const channelHistory = this.ctx.channelMessageHistory
    promptSection('channel-history', 'channel-history.prompt.md')
    this.tools.register(
      channelHistory
        ? buildStoredChannelHistoryHandler(
            channelHistory,
            (c) => this.ctx.get('stickerPool')?.rewriteInbound(c) ?? c,
            (c) => rewriteInboundImages(c, (url) => this.images.fetch(url), this.logger)
          )
        : buildReadChannelHistoryHandler()
    )

    // catalog 自己挂 ready hook，rebuild 时机一致；之后每次 chat turn
    // getOrRefresh 会按需懒重建（覆盖 ready 后才 register 的延迟插件）
    this.catalog.bind()
    this.ctx.on('ready', () => {
      // 启动时一次性迁移：补 turn_number / intra_turn_seq 到旧记录，
      // 跑完 idempotent，下次启动如果所有行都已分配会快速跳过。
      migrateTurnNumbers(this.ctx, this.logger)
        .then((r) =>
          this.logger.info(
            '[turn-migration] done: scanned=%d migrated=%d skipped=%d',
            r.scannedConversations,
            r.migratedRows,
            r.skippedConversations
          )
        )
        .catch((e) => this.logger.warn('[turn-migration] failed:', e))

      // 启动时清一次过期的图片缓存；之后每小时再扫一次（ctx.setInterval
      // 在 plugin dispose 时自动清理）。
      this.imageRefs
        .cleanup()
        .then((r) =>
          this.logger.info(
            '[image-cache] startup cleanup: removed=%d kept=%d totalBytes=%d',
            r.removed,
            r.kept,
            r.totalBytes
          )
        )
        .catch((e) =>
          this.logger.warn('[image-cache] startup cleanup failed:', e)
        )
      const cleanupImages = () =>
        this.images
          .cleanup()
          .then((r) => r.removed && this.logger.info('[images] cleanup: removed=%d kept=%d totalBytes=%d', r.removed, r.kept, r.totalBytes))
          .catch((e) => this.logger.warn('[images] cleanup failed:', e))
      cleanupImages()
      this.ctx.setInterval(cleanupImages, Time.hour)
      this.ctx.setInterval(
        () => {
          this.imageRefs
            .cleanup()
            .catch((e) =>
              this.logger.warn('[image-cache] periodic cleanup failed:', e)
            )
        },
        60 * 60 * 1000
      )
    })

    this.ctx.set('llm', this)
  }

  async #initDatabase() {
    this.ctx.model.extend('user', {
      openai_last_conversation_id: 'string',
    })
    this.ctx.model.extend('channel', {
      openai_last_conversation_id: 'string',
    })
    this.ctx.model.extend(
      'openai_chat',
      {
        id: 'integer',
        conversation_id: 'string',
        conversation_owner: 'integer',
        role: 'string',
        content: 'text',
        reasoning_content: 'text',
        tool_calls: 'text',
        tool_call_id: 'string',
        tool_name: 'string',
        usage: 'json',
        model: 'string',
        time: 'integer',
        turn_number: 'unsigned',
        intra_turn_seq: 'unsigned',
        // User rows only: how the turn ended (history-filter TurnStatus)
        // and, when it failed, why — the reason is for people, never sent.
        turn_status: 'string',
        turn_error: 'text',
        // User and tool rows: ids of the images whose pixels go with the row.
        images: 'json',
      },
      {
        primary: 'id',
        autoInc: true,
        indexes: [
          // ChatHistoryService.getById primary order
          ['conversation_id', 'turn_number', 'intra_turn_seq'],
          // 通过用户查找记录（time 仍是天然的"按时序看用户活动"键）
          ['conversation_owner', 'time'],
          // 用于可能的时间范围清理操作
          ['time'],
        ],
      }
    )
    MemoryStore.initSchema(this.ctx)
    MemoryRecordStore.initSchema(this.ctx, 'openai_user_shared_memory')
    MemoryRecordStore.initSchema(this.ctx, 'openai_group_memory')
    SessionManager.initSchema(this.ctx)
  }

  static readPromptFile(file: string) {
    try {
      return readFileSync(resolve(import.meta.dirname, `./prompts/${file}`), {
        encoding: 'utf-8',
      })
        .toString()
        .trim()
    } catch (e) {
      return ''
    }
  }

  /**
   * Resolve the (platform, userId) pair the memory store keys on for a session.
   * Same logic as the chat action — keep them in sync. Public so subplugins
   * (commands/admin, commands/chat) can use it via ctx.llm.
   */
  resolveMemoryKey(session: any): { platform: string; userId: string } {
    const platform =
      session.platform === 'onebot' ? 'qq' : session.platform || 'unknown'
    const userId = session.user?.id?.toString() || session.userId || 'anonymous'
    return { platform, userId }
  }

  /** Public read access to the cached agent command catalog (for tools.ts). */
  getCatalog(): readonly CommandCatalogEntry[] {
    return this.catalog.list()
  }

  /**
   * Hard byte limit for writes to one tier (the fork and save_user_memory
   * alike). Mirrors the soft-limit + 10% policy used in memory-fork.ts.
   */
  getMemoryHardLimit(tier: MemoryTier): number {
    const soft = {
      private: this.config.memoryByteLimit,
      shared: this.config.sharedMemoryByteLimit,
      group: this.config.groupMemoryByteLimit,
    }[tier]
    return Math.ceil((soft ?? 3000) * 1.1)
  }

  memoryStore(tier: MemoryTier): MemoryStore | MemoryRecordStore {
    return {
      private: this.memory,
      shared: this.sharedMemory,
      group: this.groupMemory,
    }[tier]
  }

  /**
   * Who owns each tier's record in this session: the user who started the
   * turn for `private` / `shared`, the channel for `group`. `uid` is the
   * record's key.
   */
  memoryOwners(session: any): Record<MemoryTier, MemoryOwner> {
    const { userId } = this.resolveMemoryKey(session)
    // The name others see here (group card, then platform nickname), not the
    // Koishi name, which can be a private nickname set with `callme`.
    const user = {
      name:
        session.event?.member?.nick ||
        session.event?.user?.name ||
        session.username ||
        userId,
      uid: userId,
    }
    const channelId = String(session.channelId ?? '')
    return {
      private: user,
      shared: user,
      group: {
        name:
          session.event?._data?.group_name ||
          session.event?.channel?.name ||
          channelId,
        uid: channelId,
      },
    }
  }

  /** The records a snapshot of these tiers carries, for these owners. */
  memorySources(
    platform: string,
    owners: Record<MemoryTier, MemoryOwner>,
    tiers: readonly MemoryTier[]
  ): MemorySnapshotSource[] {
    return tiers.map((tier) => ({
      tier,
      owner: owners[tier],
      read: () => this.memoryStore(tier).getMeta(platform, owners[tier].uid),
    }))
  }
}
