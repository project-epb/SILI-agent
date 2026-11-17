import type { Context, Logger } from 'koishi'

import type { LLMProviderBase } from '../providers/_base'
import type { ActiveChatRegistry } from './active-chats'
import type { ChatHistoryService } from './chat-history'
import { GROUP_CONVERSATION_OWNER } from './conversation-scope'
import type { OpenAISession } from './session-manager'
import type { SummaryCompactor } from './summary-compactor'

/** Conversations idle longer than this are left alone for good. */
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
/** A session used no later than this after it started never had a real turn. */
const UNUSED_SLACK_MS = 60 * 1000

export interface IdleCompactorDeps {
  ctx: Context
  logger: Logger
  history: ChatHistoryService
  summary: SummaryCompactor
  activeChats: ActiveChatRegistry
  idleMs: number
  minTokens: number
  /** Resolved at run time: the provider, model and prompt of a normal turn. */
  turnSetup(): { provider: LLMProviderBase; model: string; systemPrompt: string }
}

/**
 * Background pass: compact each current conversation that has been idle
 * for `idleMs` and whose context is at least `minTokens`, then point its
 * user (or group) at the compacted conversation. Runs one conversation at
 * a time; any failure only skips that conversation.
 */
export class IdleCompactor {
  private running = false

  constructor(private readonly deps: IdleCompactorDeps) {}

  async run(now = Date.now()): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const { ctx, idleMs } = this.deps
      const candidates = await ctx.database.get('openai_session', {
        last_used_at: { $lt: now - idleMs, $gt: now - LOOKBACK_MS },
      })
      for (const row of candidates) {
        if (row.last_used_at - row.started_at < UNUSED_SLACK_MS) continue
        await this.compactOne(row).catch((e) =>
          this.deps.logger.warn('[idle-compact] %s failed:', row.conversation_id, e)
        )
      }
    } finally {
      this.running = false
    }
  }

  private async compactOne(row: OpenAISession) {
    const { ctx, history, summary, activeChats, minTokens, logger } = this.deps
    const group = row.conversation_owner === GROUP_CONVERSATION_OWNER
    const key = group ? `group:${row.platform}:${row.user_id}` : row.conversation_owner
    if (activeChats.get(key)) return
    if ((await this.currentId(row, group)) !== row.conversation_id) return
    if ((await history.latestPromptTokens(row.conversation_id)) < minTokens) return

    const { provider, model, systemPrompt } = this.deps.turnSetup()
    const res = await summary.compactNow({
      conversation_id: row.conversation_id,
      conversation_owner: row.conversation_owner,
      // A session row does not record whether it is a DM; outside a group's
      // shared conversation it almost always is (v5 serves QQ DMs and groups).
      memoryTiers: group ? [] : ['private', 'shared'],
      systemPrompt,
      provider,
      model,
      platform: row.platform,
      userId: row.user_id,
    })
    if (!res.ran || !res.newConversationId) return

    // Someone spoke while the summary ran: their turn went to the old
    // conversation, so adopting the new one would drop it. Keep the old.
    const [fresh] = await ctx.database.get('openai_session', { id: row.id })
    if (activeChats.get(key) || fresh?.last_used_at !== row.last_used_at) return
    if ((await this.currentId(row, group)) !== row.conversation_id) return

    if (group) {
      await ctx.database.set(
        'channel',
        { platform: row.platform, id: row.user_id },
        { openai_last_conversation_id: res.newConversationId }
      )
    } else {
      await ctx.database.set(
        'user',
        { id: row.conversation_owner },
        { openai_last_conversation_id: res.newConversationId }
      )
    }
    logger.success(
      '[idle-compact] %s → %s (%d-char summary)',
      row.conversation_id,
      res.newConversationId,
      res.summaryLength
    )
  }

  private async currentId(row: OpenAISession, group: boolean) {
    const { ctx } = this.deps
    const [owner] = group
      ? await ctx.database.get(
          'channel',
          { platform: row.platform, id: row.user_id },
          ['openai_last_conversation_id']
        )
      : await ctx.database.get('user', { id: row.conversation_owner }, [
          'openai_last_conversation_id',
        ])
    return owner?.openai_last_conversation_id ?? ''
  }
}
