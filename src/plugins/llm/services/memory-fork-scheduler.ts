import type { Context, Logger } from '@koishijs/core'

import type { MemoryStore } from './memory'
import type { LLMProviderBase } from '../providers/_base'
import type { ToolRegistry } from '../tools'
import type { CommandCatalogService } from './command-catalog'
import type { SystemPromptBuilder } from './system-prompt'

/**
 * Minimal provider-config shape the scheduler reads. Mirrors a subset of
 * the union type defined by PluginLLM.config.providers — kept inline here
 * (instead of importing) to avoid a cycle with index.tsx.
 */
export interface SchedulerProviderConfig {
  name: string
  type: string
  model?: string
  maxTokens?: number
}
import type { ChatHistoryService } from './chat-history'

/**
 * Subset of PluginLLM that the memory-fork scheduler needs. Defined
 * structurally so we don't have to import the plugin class (avoids a
 * cycle and keeps the scheduler decoupled from the rest of the plugin).
 */
export interface MemoryForkSchedulerDeps {
  ctx: Context
  logger: Logger
  memory: MemoryStore
  chatHistory: ChatHistoryService
  systemPrompt: SystemPromptBuilder
  catalog: CommandCatalogService
  tools: ToolRegistry
  defaultProvider: LLMProviderBase
  useProvider(name: string): LLMProviderBase
  /** Read config lazily so config edits don't get cached. */
  config: {
    memoryModel?: string
    memoryUpdateInterval?: number
    memoryByteLimit?: number
    memoryForkMaxRetries?: number
    historyTurnCount?: number
    providers: SchedulerProviderConfig[]
    model?: string
    maxTokens?: number
  }
}

/**
 * Throttles + dispatches the LLM-driven memory-fork task. Bookkeeping (how
 * many user messages have arrived since the last fork) lives in the memory
 * store itself; this scheduler just decides "is it time?" and wires the
 * appropriate model/provider before calling into ./memory-fork.
 */
export class MemoryForkScheduler {
  constructor(private readonly deps: MemoryForkSchedulerDeps) {}

  /**
   * Resolve which (provider, model, maxTokens) to use for memory fork.
   * Honors `memoryModel` config (e.g. "openrouter#claude-haiku-4.5"),
   * falling back to the default provider/model.
   */
  private resolveProvider(): {
    provider: LLMProviderBase
    model: string
    maxTokens: number
  } {
    const { config, defaultProvider, useProvider, logger } = this.deps
    const defaultProviderConfig = config.providers[0]
    const fallback = () => ({
      provider: defaultProvider,
      model: defaultProviderConfig?.model || config.model || 'gpt-4o-mini',
      maxTokens:
        defaultProviderConfig?.maxTokens ?? config.maxTokens ?? 1024,
    })

    const spec = config.memoryModel?.trim()
    if (!spec) return fallback()

    const m = spec.match(/^([^#:]+)[#:](.+)$/)
    let providerName: string | undefined
    let model: string
    if (m) {
      providerName = m[1].trim()
      model = m[2].trim()
    } else {
      model = spec
    }

    const providerConfig = providerName
      ? config.providers.find((p) => p.name === providerName)
      : defaultProviderConfig

    if (providerName && !providerConfig) {
      logger.warn(
        '[memory] memoryModel provider %s not found, falling back to default',
        providerName
      )
      return fallback()
    }

    const provider = providerName
      ? useProvider(providerName)
      : defaultProvider
    const maxTokens = providerConfig?.maxTokens ?? config.maxTokens ?? 1024
    return {
      provider,
      model: model || providerConfig?.model || 'gpt-4o-mini',
      maxTokens,
    }
  }

  /**
   * Fire memory-fork if the user has accumulated enough messages since
   * last update (or unconditionally when `force: true`). Best-effort:
   * underlying memory-fork errors are swallowed by the caller's catch.
   */
  async maybeTrigger(
    args: {
      platform: string
      userId: string
      conversation_id: string
      conversation_owner: number
    },
    opts: { force?: boolean } = {}
  ): Promise<void> {
    const {
      ctx,
      logger,
      memory,
      chatHistory,
      systemPrompt,
      catalog,
      tools,
      config,
    } = this.deps
    const interval = config.memoryUpdateInterval ?? 10
    const byteLimit = config.memoryByteLimit ?? 3000
    const maxRetries = config.memoryForkMaxRetries ?? 3
    // history 长度跟主对话保持一致，[system + history] 前缀才对得上：
    // 主对话发请求时本轮 user 还没落库，fork 触发时本轮 user/assistant 已落库，
    // 所以 fork 拿 N turn 包含本轮，主对话则是 N-1 turn + 当前 user。
    // 二者前缀完全包含到 t0-user，命中自动前缀缓存。
    const historyTurns = config.historyTurnCount ?? 10

    const meta = await memory.getMeta(args.platform, args.userId)
    // 只数当前 conversation 内的 user 消息：原设计是"当前 session 超过 N 轮
    // 触发一次"，跨会话不应累计（idle timeout 切了新 conversation_id 后，
    // 旧会话的计数就不该再决定新会话的 fork 时机）。
    const userMessages = await ctx.database.get(
      'openai_chat',
      {
        conversation_owner: args.conversation_owner,
        conversation_id: args.conversation_id,
        role: 'user',
      },
      { fields: ['id'] }
    )
    const userMessageCount = userMessages?.length ?? 0
    if (!opts.force) {
      // 跨会话时基线视为 0：上次 fork 记录的 conversation_id 跟当前不一致，
      // 说明已轮换到新 session，count 也是从 0 开始的，比较起点应同步归零。
      const sameConversation =
        meta?.last_forked_conversation_id === args.conversation_id
      const baseline = sameConversation
        ? (meta?.message_count_at_update ?? 0)
        : 0
      const since = userMessageCount - baseline
      if (since < interval) return
    }

    // 拉取对话上下文（reasoning_content 已在 ChatHistoryService 默认带上）
    const history = await chatHistory.getById(args.conversation_id, historyTurns)

    const { provider, model, maxTokens } = this.resolveProvider()
    // 用主对话同一份 system prompt（同 catalog → memoize 命中同一字符串）
    const sharedSystemPrompt = systemPrompt.get(catalog.getOrRefresh())
    // 同一份 tools 列表，让 fork 请求的 prefix tokens 跟主对话对齐；
    // toolChoice='none' 在 memory-fork 内部强制（不会真调用任何工具）
    const sharedTools = tools.listDefinitions()

    const { maybeRunMemoryFork } = await import('./memory-fork')
    await maybeRunMemoryFork({
      ctx,
      logger,
      store: memory,
      provider,
      model,
      maxTokens,
      byteLimit,
      maxRetries,
      platform: args.platform,
      userId: args.userId,
      conversationId: args.conversation_id,
      currentMessageCount: userMessageCount,
      history,
      systemPrompt: sharedSystemPrompt,
      tools: sharedTools,
    })
  }
}
