import type { Logger } from 'koishi'

import {
  type MemoryOwner,
  type MemoryTier,
  renderMemoryBlock,
} from '../tools/read-user-memory'

/** One record a snapshot may carry, already resolved to its owner. */
export interface MemorySnapshotSource {
  tier: MemoryTier
  owner: MemoryOwner
  read: () => Promise<{ content: string } | null>
}

/**
 * Render records as a `<long_term_memory>` block to embed at the start of
 * the first user message of a fresh conversation. Two callers:
 *
 *   - chat.tsx — the FIRST user envelope of any brand-new conversation
 *     (initial chat, post-`llm.reset`, idle rotation)
 *   - SummaryCompactor — the synthetic "please summarize" user message
 *     that seeds a compacted session
 *
 * The records become part of the cached prefix of the new conversation.
 * Each one is wrapped in `<user_memory>` with its owner and tier. The caller
 * decides which records a conversation may carry (`LLMPlugin.memorySources`):
 * a DM gets the user's private and shared ones, a group's shared
 * conversation only that group's memory.
 *
 * Returns '' when no record has content (or a fetch fails).
 */
export async function buildMemorySnapshot(
  sources: readonly MemorySnapshotSource[],
  logger?: Logger
): Promise<string> {
  try {
    const blocks: string[] = []
    for (const { tier, owner, read } of sources) {
      const raw = (await read())?.content?.trim()
      if (raw) blocks.push(renderMemoryBlock(owner, tier, raw))
    }
    if (!blocks.length) return ''
    return [
      '<long_term_memory>',
      '（系统在创建本会话时为你 freeze 的长期记忆快照；如果对话期间已经过去很久、有人提到新情况，可调用 read_user_memory 拉最新版本。）',
      '',
      blocks.join('\n\n'),
      '</long_term_memory>',
    ].join('\n')
  } catch (e: any) {
    logger?.warn('[memory-snapshot] failed to load:', e)
    return ''
  }
}
