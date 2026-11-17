import type { Logger } from 'koishi'

import {
  type MemoryTier,
  renderMemoryBlock,
} from '../tools/read-user-memory'

/** Anything that can look up one tier's record. */
export interface MemoryRecordSource {
  getMeta(
    platform: string,
    userId: string
  ): Promise<{ content: string } | null>
}

export type MemorySnapshotStores = Record<MemoryTier, MemoryRecordSource>

/**
 * Render a user's records as a `<long_term_memory>` block to embed at the
 * start of the first user message of a fresh conversation. Two callers:
 *
 *   - chat.tsx — the FIRST user envelope of any brand-new conversation
 *     (initial chat, post-`llm.reset`, idle rotation)
 *   - SummaryCompactor — the synthetic "please summarize" user message
 *     that seeds a compacted session
 *
 * The records become part of the cached prefix of the new conversation.
 * Each one is wrapped in `<user_memory>` with its owner and tier. `tiers`
 * says which records the conversation may carry: never `private` outside
 * a DM, nothing at all in a group's shared conversation.
 *
 * Returns '' when no listed record has content (or fetch fails).
 */
export async function buildMemorySnapshot(
  stores: MemorySnapshotStores,
  platform: string,
  userId: string,
  tiers: readonly MemoryTier[],
  logger?: Logger,
  ownerName = '这位用户'
): Promise<string> {
  try {
    const blocks: string[] = []
    for (const tier of tiers) {
      const raw = (await stores[tier].getMeta(platform, userId))?.content?.trim()
      if (raw) blocks.push(renderMemoryBlock({ name: ownerName, uid: userId }, tier, raw))
    }
    if (!blocks.length) return ''
    return [
      '<long_term_memory>',
      '（系统在创建本会话时为你 freeze 的长期记忆快照；如果对话期间已经过去很久、用户提到新偏好，可调用 read_user_memory 拉最新版本。）',
      '',
      blocks.join('\n\n'),
      '</long_term_memory>',
    ].join('\n')
  } catch (e: any) {
    logger?.warn('[memory-snapshot] failed to load:', e)
    return ''
  }
}
