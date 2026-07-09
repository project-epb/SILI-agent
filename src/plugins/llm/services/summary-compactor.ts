import type { Context, Logger } from '@koishijs/core'

import type {
  ChatMessage,
  LLMProviderBase,
} from '../providers/_base'
import { PROTOCOL_TAGS } from '../utils/protocol'

import type { ChatHistoryService } from './chat-history'
import type { MemoryStore } from './memory'
import { buildMemorySnapshot } from './memory-snapshot'
import type { SessionManager } from './session-manager'
import type { TurnAllocator } from './turn-allocator'

/**
 * Default prompt fed as the synthetic "user" message when compaction
 * fires. Reads naturally in both directions:
 *   - at generation time the model sees `[system, ...full history,
 *     user(this prompt)]` and produces a summary from the visible
 *     conversation
 *   - in the next session the model sees `[system, user(this prompt),
 *     assistant(summary), user(new question)]` and infers "previous
 *     conversation was compacted; the summary is my carry-over memory"
 */
export const DEFAULT_SUMMARY_PROMPT = [
  '对话上下文已达上限。将以上对话整理成一段简洁的摘要，作为后续继续对话的起点。',
  '',
  '整理要点：',
  '- 关键事实：用户身份 / 职业 / 当前项目背景等长效信息',
  '- 已建立的偏好：语气习惯、技术栈倾向、明确表达过的「喜欢 / 不喜欢」',
  '- 未完成的话题：对话中提到但未结束的事情（"有空再继续看 X"、"下次提醒我做 Y"）',
  '- 重要决策：双方达成共识的设计选择、立场判断',
  '- 工具调用揭示的关键信息（read_user_memory / web_search / read_channel_history 等返回的事实）',
  '',
  '格式要求：',
  '- 以导演视角编写「SILI与该用户之前聊了……」的摘要，中立，不进行任何角色扮演',
  '- 控制在 800 字以内',
  '- 直接输出摘要正文，不要前缀「好的我来总结」之类的客套话',
  '- 禁止调用任何 tool',
].join('\n')

export interface SummaryCompactorOptions {
  /**
   * Trigger threshold: when user message count in current conversation
   * reaches this value, compact (rotate to new conversation seeded with
   * a summary pair). Set to 0 to disable.
   */
  threshold: number
  /** Max tokens to allow for the summary completion. */
  maxTokens?: number
  /** Override the summary user prompt (defaults to DEFAULT_SUMMARY_PROMPT). */
  prompt?: string
}

export interface CompactIfNeededInput {
  conversation_id: string
  conversation_owner: number
  /** Cached system prompt — same string a regular chat turn would use. */
  systemPrompt: string
  provider: LLMProviderBase
  model: string
  /** For new session row metadata. */
  platform: string
  userId: string
  /** Per-call overrides from the chat command. */
  features?: { signal?: AbortSignal }
}

export interface CompactionResult {
  ran: boolean
  reason?: string
  summaryLength?: number
  /**
   * When `ran` is true, the conversation_id the caller should adopt for
   * the rest of this chat invocation (and persist to user row /
   * activeChats entry). The old conversation_id is left intact in db
   * but no longer loaded by history.
   */
  newConversationId?: string
  prevConversationId?: string
}

/**
 * Triggered synchronously from the chat command BEFORE history load.
 *
 * Strategy: when user-turn count for the current conversation crosses
 * the threshold, run one summary call against the same provider+model+
 * system prompt the chat is about to use (maximizes prompt-cache reuse
 * — the prefix sent to the summary model is byte-identical to a normal
 * chat turn). Then mint a NEW `conversation_id`, persist the synthetic
 * (user "please summarize", assistant "<summary text>") pair as turn 1
 * of the new conversation, and create a new session row linked back to
 * the previous one via `prev_session_id`. Caller adopts the new id.
 *
 * Why rotate instead of marking rows? The new conversation_id IS the
 * compaction boundary — `getById` naturally returns only post-summary
 * rows because it filters by conversation_id. No schema flags, no skip
 * logic. The summary pair reads naturally from the model's POV: it
 * sees a "user asked for a summary, assistant gave one, now continue
 * the conversation" arc.
 *
 * Failures are logged and swallowed — chat proceeds on the un-
 * compacted conversation, threshold check re-runs next turn.
 */
export class SummaryCompactor {
  constructor(
    private readonly ctx: Context,
    private readonly logger: Logger,
    private readonly history: ChatHistoryService,
    private readonly sessions: SessionManager,
    private readonly turns: TurnAllocator,
    private readonly memory: Pick<MemoryStore, 'getMeta'>,
    private readonly options: SummaryCompactorOptions
  ) {}

  // Memory snapshot building is shared with chat.tsx via
  // `services/memory-snapshot.ts` — see buildMemorySnapshot().

  /**
   * Threshold-gated entry called by the chat command on every turn.
   * Delegates the actual work to `compactNow` once the user-turn count
   * crosses the configured threshold.
   */
  async compactIfNeeded(input: CompactIfNeededInput): Promise<CompactionResult> {
    const { threshold } = this.options
    if (!threshold || threshold <= 0) {
      return { ran: false, reason: 'disabled' }
    }

    const count = await this.history.countUserMessages(input.conversation_id)
    if (count < threshold) {
      return { ran: false, reason: `under threshold (${count}/${threshold})` }
    }
    return this.compactNow(input)
  }

  /**
   * Unconditional compaction — bypasses the threshold. Exposed for the
   * hidden `llm.compact` admin command so operators can force-rotate a
   * conversation on demand (debugging, manual cleanup, before-test reset).
   * Still gracefully handles edge cases (empty history, empty summary,
   * provider failure) by returning `{ ran: false, reason: ... }`.
   */
  async compactNow(input: CompactIfNeededInput): Promise<CompactionResult> {
    // Load the same shape of history that a normal chat turn would see,
    // so the prefix sent to the summary model byte-matches the live
    // chat path and benefits from existing prompt cache state. Use a
    // generous cap so we don't accidentally truncate just because
    // historyTurnCount is small.
    const history = await this.history.getById(input.conversation_id, 200)
    if (history.length === 0) {
      return { ran: false, reason: 'no history to summarize' }
    }

    const memorySnapshot = await buildMemorySnapshot(
      this.memory,
      input.platform,
      input.userId,
      this.logger
    )
    const compactInstruction = [
      PROTOCOL_TAGS.SYSTEM_COMPACT.open,
      this.options.prompt ?? DEFAULT_SUMMARY_PROMPT,
      PROTOCOL_TAGS.SYSTEM_COMPACT.close,
    ].join('')
    // Memory comes first (becomes the start of the cached prefix in the
    // new session), then the compaction instruction. When the user has
    // no memory the snapshot is empty and we send just the instruction.
    const summaryPrompt = memorySnapshot
      ? `${memorySnapshot}\n\n${compactInstruction}`
      : compactInstruction
    const messages: ChatMessage[] = [
      { role: 'system', content: input.systemPrompt },
      ...history,
      { role: 'user', content: summaryPrompt },
    ]

    let summaryText: string
    try {
      summaryText = await this.runSummaryCall(input, messages)
    } catch (e: any) {
      this.logger.warn('[summary] compaction call failed:', e)
      return { ran: false, reason: `call failed: ${e?.message ?? e}` }
    }

    summaryText = summaryText.trim()
    if (!summaryText) {
      return { ran: false, reason: 'empty summary' }
    }

    // Mint the new conversation and seed it with the synthetic
    // (user summary-request, assistant summary-response) turn.
    const newConversationId = crypto.randomUUID()
    const turnNumber = await this.turns.allocate(newConversationId) // 1
    const time = Date.now()

    try {
      await this.ctx.database.create('openai_chat', {
        conversation_owner: input.conversation_owner,
        conversation_id: newConversationId,
        role: 'user',
        content: summaryPrompt,
        reasoning_content: '',
        turn_number: turnNumber,
        intra_turn_seq: 0,
        time,
      } as any)
      await this.ctx.database.create('openai_chat', {
        conversation_owner: input.conversation_owner,
        conversation_id: newConversationId,
        role: 'assistant',
        content: summaryText,
        reasoning_content: '',
        turn_number: turnNumber,
        intra_turn_seq: 1,
        time,
        model: input.model,
      } as any)
      await this.sessions.create({
        conversationId: newConversationId,
        conversationOwner: input.conversation_owner,
        platform: input.platform,
        userId: input.userId,
        userFirstMsg: summaryPrompt,
        prevSessionId: input.conversation_id,
      })
    } catch (e: any) {
      this.logger.warn('[summary] failed to persist compacted session:', e)
      return { ran: false, reason: `persist failed: ${e?.message ?? e}` }
    }

    this.logger.success(
      '[summary] compacted %d history msgs: %s → %s (%d-char summary)',
      history.length,
      input.conversation_id,
      newConversationId,
      summaryText.length
    )

    return {
      ran: true,
      summaryLength: summaryText.length,
      newConversationId,
      prevConversationId: input.conversation_id,
    }
  }

  private async runSummaryCall(
    input: CompactIfNeededInput,
    messages: ChatMessage[]
  ): Promise<string> {
    const stream = input.provider.streamChatCompletion(
      messages,
      {
        model: input.model,
        maxTokens: this.options.maxTokens ?? 1500,
        // Lower temp + tools off: we want a deterministic, plain-text
        // summary, no tool calls polluting the synthetic turn.
        temperature: 0.3,
        topP: 0.9,
        tools: [],
      },
      { signal: input.features?.signal }
    )

    let content = ''
    for await (const delta of stream) {
      if (delta.kind === 'content') content += delta.content
      else if (delta.kind === 'error') throw delta.error
    }
    return content
  }
}
