import type { Logger } from '@koishijs/core'

import type { MemoryStore } from './memory'

/**
 * Render the user's long-term memory as a `<long_term_memory>` XML
 * block to embed at the start of a synthetic / first user message in a
 * fresh conversation. Two callers use this:
 *
 *   - SummaryCompactor — prepends the snapshot to the synthetic
 *     "please summarize" user message that seeds a compacted session
 *   - chat.tsx — prepends the snapshot to the FIRST user envelope of
 *     any brand-new conversation (initial chat, post-`llm.reset`, idle
 *     rotation), so non-compaction-spawned sessions also get the
 *     memory bootstrap and don't waste a round-trip on read_user_memory
 *
 * Effect: memory becomes part of the cached prefix for the entire new
 * conversation, the model has it in context from turn 1 without a
 * tool call, and routine "what do you remember about me" questions
 * are answerable instantly. The note inside the block tells the model
 * the snapshot is frozen and to call `read_user_memory` for fresh
 * data if the conversation has run long enough that updates may have
 * landed.
 *
 * Returns '' when the user has no memory yet (or fetch fails), so
 * users without memory rows aren't burdened with empty placeholder
 * text in their fresh conversations.
 */
export async function buildMemorySnapshot(
  memory: Pick<MemoryStore, 'getMeta'>,
  platform: string,
  userId: string,
  logger?: Logger
): Promise<string> {
  try {
    const meta = await memory.getMeta(platform, userId)
    const raw = meta?.content?.trim()
    if (!raw) return ''
    return [
      '<long_term_memory>',
      '（系统在创建本会话时为你 freeze 的长期记忆快照；如果对话期间已经过去很久、用户提到新偏好，可调用 read_user_memory 拉最新版本。）',
      '',
      raw,
      '</long_term_memory>',
    ].join('\n')
  } catch (e: any) {
    logger?.warn('[memory-snapshot] failed to load:', e)
    return ''
  }
}
