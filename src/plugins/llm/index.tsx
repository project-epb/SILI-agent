/**
 * AI Chat Plugin - make chat bot great again!
 * @author dragon-fish
 * @license MIT
 */
import { Context } from '@koishijs/core'

import { readFileSync } from 'node:fs'
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
import { ActiveChatRegistry } from './services/active-chats'
import { ChatHistoryService } from './services/chat-history'
import { CommandCatalogService } from './services/command-catalog'
import { ImageReferenceCache } from './services/image-cache'
import { MemoryStore } from './services/memory'
import { MemoryForkScheduler } from './services/memory-fork-scheduler'
import { SessionManager } from './services/session-manager'
import { SummaryCompactor } from './services/summary-compactor'
import { SystemPromptBuilder } from './services/system-prompt'
import { TavilySearchClient } from './services/tavily-client'
import { TurnAllocator } from './services/turn-allocator'
import { migrateTurnNumbers } from './services/turn-migration'
import {
  EXTRACT_WEBPAGES_TOOL,
  READ_USER_MEMORY_TOOL,
  ToolRegistry,
  WEB_SEARCH_TOOL,
  buildCodeSandboxHandler,
  buildReadChannelHistoryHandler,
  buildSaveUserMemoryTool,
  executeKoishiCommandHandler,
  getMemoryToolState,
  getWebToolsState,
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
}

export type ProviderConfig =
  | {
      name: string
      type: 'openai'
      options: ClientOptions
      model?: string
      maxTokens?: number
    }
  | {
      name: string
      type: 'anthropic'
      options: AnthropicClientOptions
      model?: string
      maxTokens?: number
    }
  | {
      name: string
      type: 'copilot'
      options: ClientOptions
      model?: string
      maxTokens?: number
    }

export interface Config {
  providers: ProviderConfig[]
  model?: string
  /**
   * 单次拉多少 user turn 进 prompt。一个 turn = 1 user + 0..N
   * assistant(tool_calls) + 0..N tool result + 1 final assistant，整 turn
   * 完整入选，不会被截断到中间。落到实际 ChatMessage 行数会比这个数大
   * （工具调用越密越大），但 IM 场景一般就 1.5-3 倍。
   *
   * 注意：滑窗一旦触发就会让 prompt 前缀变化、prefix cache 全部失效。
   * 推荐设置 >= `summarizeAfterUserTurns`，让 summary 比滑窗先触发，
   * 这样 cache 命中率才能真正受益于摘要压缩。
   */
  historyTurnCount?: number
  /**
   * 同一 conversation 内累计多少条 user message 后触发一次 summary
   * compaction：把当前 system + 历史 + "请总结" 发给主模型，把得到的
   * 摘要作为新的会话基点持久化（is_summary 标记）。后续 turn 只加载
   * 摘要之后的 row，从而把整个早期上下文压缩成一对稳定的 user+
   * assistant 消息——cache 在长会话里仍能维持高命中率。
   *
   * 计数是「自上一次 summary 以来的 user turn 数」（无 summary 则从
   * conversation 起点算），所以默认 50 意味着每 50 条用户消息触发一次
   * 摘要。设为 0 关闭功能（保留旧的纯滑窗行为）。
   */
  summarizeAfterUserTurns?: number
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
  showToolCallNotice?: boolean
  /**
   * DeepSeek "DSML leak" workaround (see utils/dsml-leak.ts): when the model
   * dumps its tool-call markup as plain content, re-send the same payload
   * this many times before giving up (then a graceful fallback reply shows).
   * Re-rolls don't consume the tool-iteration budget. 0 disables. Default 2.
   */
  dsmlLeakMaxRetries?: number
  memoryByteLimit?: number
  memoryUpdateInterval?: number
  memoryForkMaxRetries?: number
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
   * Tavily-backed `web_search` tool. When set, the agent gets a `web_search`
   * tool it can call for live internet lookups. Without this config the
   * tool is not registered and the agent has no web-search capability
   * (existing provider-side `enableSearch` flag is unaffected).
   */
  tavily?: {
    apiKey: string
    searchDepth?: 'basic' | 'advanced' | 'fast' | 'ultra-fast'
    topic?: 'general' | 'news' | 'finance'
    /** Default result count if the agent doesn't pass max_results. Default 5. */
    defaultMaxResults?: number
    /** Hard cap for max_results (agent requests above this are clamped). Default 10. */
    maxResultsCap?: number
    /** Per-request timeout in seconds. Default 15. */
    timeoutSeconds?: number
    /** Extract depth: `basic` is fast, `advanced` more thorough. Default basic. */
    extractDepth?: 'basic' | 'advanced'
    /** Hard cap for URLs per single extract call. Default 5. */
    maxExtractUrlsPerCall?: number
    /** Per-turn cap for `web_search` tool calls. Default 3. */
    maxSearchCallsPerTurn?: number
    /** Per-turn cap for `extract_webpages` tool calls. Default 2. */
    maxExtractCallsPerTurn?: number
  }
  /**
   * Local QuickJS-based code sandbox tool. Defaults to enabled. Set
   * `{ enabled: false }` to disable. No external service / API key
   * needed; the WASM module is bundled with quickjs-emscripten.
   */
  codeSandbox?: {
    enabled?: boolean
    memoryLimitMb?: number
    maxTimeoutMs?: number
    defaultTimeoutMs?: number
    stdoutByteLimit?: number
    returnValueByteCap?: number
    /**
     * Escape hatch: skip QuickJS setMemoryLimit + setMaxStackSize.
     * Default false — leave it that way unless you've verified your
     * environment doesn't catch DoS via the QuickJS-internal caps.
     * Setting to true means sandboxed user code can allocate arbitrary
     * host memory (limited only by container cgroup), which is a real
     * DoS vector if user input can reach the tool. The earlier
     * "singleton WASM corruption" bug that motivated default-true is
     * now sidestepped by per-call newQuickJSWASMModule().
     */
    disableHostLimits?: boolean
    /**
     * Host-side RSS-growth cap (MB), best-effort defense-in-depth.
     * Default 128. See runtime jsdoc for caveats — primary DoS
     * defense is memoryLimitMb via setMemoryLimit.
     */
    rssGrowthCapMb?: number
  }
}
export declare const Config: Config

export default class PluginLLM extends BasePlugin<Config> {
  static inject: Inject = {
    database: { required: true },
    html: { required: false },
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
  readonly memory: MemoryStore = new MemoryStore(this.ctx)
  readonly sessions: SessionManager = new SessionManager(this.ctx)
  readonly tools: ToolRegistry = new ToolRegistry()
  readonly imageRefs: ImageReferenceCache = new ImageReferenceCache({
    dir: resolve(this.ctx.baseDir, 'data', 'llm', 'image-cache'),
    maxBytes: this.config.imageCacheMaxBytes,
    ttlMs: this.config.imageCacheTtlMs,
    maxImageBytes: this.config.imageCacheMaxImageBytes,
  })
  readonly systemPrompt: SystemPromptBuilder = new SystemPromptBuilder(
    () => this.config.systemPrompt.default ?? '',
    this.ctx
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
  // resolved config (threshold from `summarizeAfterUserTurns`).
  summary!: SummaryCompactor

  constructor(ctx: Context, config: Config) {
    // One-time compat: 旧字段名 historyMessageCount → historyTurnCount。
    // 单位语义不变（一直是 user turn 数）；仅改名以避免误导成"消息行数"。
    // 读完即丢，下游代码统一只看 historyTurnCount。
    const legacy = (config as any).historyMessageCount
    let migratedFromLegacyName = false
    if (legacy !== undefined && config.historyTurnCount === undefined) {
      config.historyTurnCount = legacy
      migratedFromLegacyName = true
    }
    if ('historyMessageCount' in (config as any)) {
      delete (config as any).historyMessageCount
    }

    const defaultConfigs: Partial<Config> = {
      model: 'gpt-4o-mini',
      maxTokens: 8192,
      historyTurnCount: 50,
      summarizeAfterUserTurns: 50,
      persistWrappedUserMessage: true,
      enableAgent: true,
      maxToolIterations: 5,
      showToolCallNotice: true,
      dsmlLeakMaxRetries: 2,
      memoryByteLimit: 3000,
      memoryUpdateInterval: 10,
      memoryForkMaxRetries: 3,
      sessionIdleTimeoutMs: 3 * 24 * 60 * 60 * 1000, // 3 days
      systemPrompt: {
        default:
          process.env.KOISHI_ENV === 'dev'
            ? PluginLLM.readPromptFile('Noir.prompt.md')
            : PluginLLM.readPromptFile('SILI-v6.prompt.md'),
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

    if (migratedFromLegacyName) {
      this.logger.warn(
        '[config] "historyMessageCount" is deprecated; rename to "historyTurnCount" (semantics unchanged — counts user turns, not raw message rows).'
      )
    }

    this.summary = new SummaryCompactor(
      this.ctx,
      this.logger,
      this.chatHistory,
      this.sessions,
      this.turns,
      this.memory,
      { threshold: config.summarizeAfterUserTurns ?? 50 }
    )

    for (const providerConfig of config.providers) {
      switch (providerConfig.type) {
        case 'openai':
          this.providers.set(
            providerConfig.name,
            new OpenAIProvider(providerConfig.options)
          )
          break
        case 'anthropic':
          this.providers.set(
            providerConfig.name,
            new AnthropicProvider(providerConfig.options)
          )
          break
        case 'copilot':
          this.providers.set(
            providerConfig.name,
            new CopilotProvider(providerConfig.options)
          )
          break
        default:
          this.logger.warn(
            `Unknown provider type: ${(providerConfig as any).type}`
          )
      }
    }

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
    this.tools.register({
      definition: READ_USER_MEMORY_TOOL,
      execute: async (_args, { session, turnState }) => {
        const { platform, userId } = this.resolveMemoryKey(session)
        const result = await runReadUserMemory(this.memory, platform, userId, {
          hardLimit: this.getMemoryHardLimit(),
        })
        const state = getMemoryToolState(turnState)
        state.hasReadInTurn = true
        state.lastSeenUpdatedAt = result.lastUpdatedAt
        return result.text
      },
    })
    this.tools.register({
      definition: buildSaveUserMemoryTool(this.getMemoryHardLimit()),
      execute: async (args, { ctx, session, turnState }) => {
        const { platform, userId } = this.resolveMemoryKey(session)
        const conversationId =
          (session.user as any)?.openai_last_conversation_id ?? ''
        if (!conversationId) {
          return 'Error: no active conversation. Skip this turn and try again on the next user message.'
        }
        const conversationOwner = (session.user as any)?.id ?? 0
        const state = getMemoryToolState(turnState)
        return runSaveUserMemory(args as any, state, {
          memory: this.memory,
          platform,
          userId,
          conversationId,
          getCurrentUserMessageCount: async () => {
            const rows = await ctx.database.get(
              'openai_chat',
              {
                conversation_owner: conversationOwner,
                conversation_id: conversationId,
                role: 'user',
              },
              { fields: ['id'] }
            )
            return rows?.length ?? 0
          },
          hardLimit: this.getMemoryHardLimit(),
        })
      },
    })

    // 可选工具：web_search + extract_webpages（仅在配置了 tavily.apiKey 时注册）
    if (config.tavily?.apiKey) {
      const tavilyConfig = config.tavily
      const tavilyClient = new TavilySearchClient({
        apiKey: tavilyConfig.apiKey,
        searchDepth: tavilyConfig.searchDepth,
        topic: tavilyConfig.topic,
        timeoutSeconds: tavilyConfig.timeoutSeconds,
        extractDepth: tavilyConfig.extractDepth,
      })
      this.tools.register({
        definition: WEB_SEARCH_TOOL,
        execute: async (args, { turnState }) =>
          runWebSearch(args as any, tavilyClient, getWebToolsState(turnState), {
            defaultMaxResults: tavilyConfig.defaultMaxResults,
            maxResultsCap: tavilyConfig.maxResultsCap,
            maxCallsPerTurn: tavilyConfig.maxSearchCallsPerTurn,
          }),
      })
      this.tools.register({
        definition: EXTRACT_WEBPAGES_TOOL,
        execute: async (args, { turnState }) =>
          runWebExtract(
            args as any,
            tavilyClient,
            getWebToolsState(turnState),
            {
              maxUrlsPerCall: tavilyConfig.maxExtractUrlsPerCall,
              maxCallsPerTurn: tavilyConfig.maxExtractCallsPerTurn,
            }
          ),
      })
    }

    // code-sandbox: 本地 QuickJS 沙箱工具，默认开启（不需要 API key）
    const sb = config.codeSandbox ?? {}
    if (sb.enabled !== false) {
      this.tools.register(
        buildCodeSandboxHandler(this.logger, {
          memoryLimitMb: sb.memoryLimitMb,
          defaultTimeoutMs: sb.defaultTimeoutMs,
          maxTimeoutMs: sb.maxTimeoutMs,
          stdoutByteLimit: sb.stdoutByteLimit,
          returnValueByteCap: sb.returnValueByteCap,
          disableHostLimits: sb.disableHostLimits,
          rssGrowthCapMb: sb.rssGrowthCapMb,
        })
      )
    }

    // read_channel_history: 通过 OneBot get_group_msg_history 拉群历史。
    // 仅在 onebot 平台 + 群聊上下文里可用，handler 自己做平台/场景检查。
    this.tools.register(buildReadChannelHistoryHandler())

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

      // 预热 code-sandbox WASM，把首次 tool call 的 ~100-200ms 加载延迟从
      // 用户感知路径里移走。失败不影响主流程（第一次实际调用会重新尝试加载）。
      const sbHandler = this.tools.get('run_code_sandbox')
      if (sbHandler) {
        ;(async () => {
          try {
            const { CodeSandboxRuntime } =
              await import('./services/code-sandbox-runtime')
            await new CodeSandboxRuntime(this.logger).warmup()
            this.logger.info('[code-sandbox] warmup ok')
          } catch (e) {
            this.logger.warn('[code-sandbox] warmup failed:', e)
          }
        })()
      }
    })

    this.ctx.set('llm', this)
  }

  async #initDatabase() {
    this.ctx.model.extend('user', {
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
   * Hard byte limit for memory writes (both fork and the save_user_memory
   * tool). Mirrors the soft-limit + 10% policy used in memory-fork.ts.
   */
  private getMemoryHardLimit(): number {
    const soft = this.config.memoryByteLimit ?? 3000
    return Math.ceil(soft * 1.1)
  }
}
