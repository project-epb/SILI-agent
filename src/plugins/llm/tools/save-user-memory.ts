import { byteLength } from '../services/memory'
import type { ToolDefinition } from '../providers/_base'

import {
  type MemoryOwner,
  type MemoryTier,
  type MemoryToolState,
  MEMORY_TIERS,
  TIER_LABEL,
} from './read-user-memory'

export interface SaveUserMemoryInput {
  tier: MemoryTier
  content: string
}

export interface SaveUserMemoryDeps {
  /**
   * The session is a DM: only then may the private record be written, and
   * only outside one the group's memory.
   */
  isDirect: boolean
  /** Who owns each tier's record here: the user, or the group. */
  owners: Record<MemoryTier, MemoryOwner>
  /** Last update time of the record about to be overwritten (0 = none). */
  getUpdatedAt: (tier: MemoryTier) => Promise<number>
  write: (tier: MemoryTier, content: string) => Promise<void>
  /** Hard byte limit (UTF-8) per tier. Inputs above it are rejected. */
  hardLimits: Record<MemoryTier, number>
}

/**
 * Build the save_user_memory tool definition with the byte limits baked
 * into the description (so the agent sees concrete numbers).
 */
export function buildSaveUserMemoryTool(
  hardLimits: Record<MemoryTier, number>
): ToolDefinition {
  return {
    name: 'save_user_memory',
    description: [
      '完整覆写一份记录（不是 patch）。每份每轮只能写一次，写之前必须先 `read_user_memory`；读之后若被后台整理任务改过，会被乐观锁拒绝并要求重读。私密记录只能在私聊里写，群记忆只能在群里写；这一轮有别人插话时，写个人记录会被拒绝。',
      `硬上限：private ${hardLimits.private} 字节，shared ${hardLimits.shared} 字节，group ${hardLimits.group} 字节（UTF-8）；空白内容会被拒绝。`,
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        tier: {
          type: 'string',
          enum: [...MEMORY_TIERS],
          description: '写哪份记录：private（仅私聊）、shared（所有群可见）或 group（本群，仅群里）。',
        },
        content: {
          type: 'string',
          description:
            '这份记录的完整新内容（markdown），覆盖现有内容。基于 read_user_memory 拿到的内容增改后给出整份。',
        },
      },
      required: ['tier', 'content'],
      additionalProperties: false,
    },
  }
}

export async function runSaveUserMemory(
  input: Partial<SaveUserMemoryInput> | undefined,
  state: MemoryToolState,
  deps: SaveUserMemoryDeps
): Promise<string> {
  const tier = input?.tier
  if (tier !== 'private' && tier !== 'shared' && tier !== 'group') {
    return 'Error: tool input field "tier" must be "private", "shared" or "group".'
  }
  if (tier === 'private' && !deps.isDirect) {
    return 'Error: 私密记录只能在私聊里改。群里只能写共享记录（shared，只记可以公开的内容）或群记忆（group）。'
  }
  if (tier === 'group' && deps.isDirect) {
    return 'Error: 群记忆只能在群里改。'
  }
  if (tier !== 'group' && state.othersSpoke) {
    return 'Error: 这一轮里有别人的消息，不能写入记录——只根据本人自己说的话记。等他下次自己说的时候再记。'
  }
  const ts = state[tier]
  if (!ts.hasRead) {
    return 'Error: please call read_user_memory first to see current content before saving.'
  }
  if (ts.saved) {
    return `Error: the ${tier} record was already saved in this turn. Combine all updates into a single call.`
  }
  if (typeof input?.content !== 'string') {
    return 'Error: tool input missing required field "content"'
  }
  const trimmed = input.content.trim()
  if (!trimmed) {
    return 'Error: content is empty or whitespace only — refusing to overwrite memory with nothing. To make no change, simply do not call this tool.'
  }
  const size = byteLength(trimmed)
  const hardLimit = deps.hardLimits[tier]
  if (size > hardLimit) {
    return `Error: content is ${size} bytes, exceeds the ${tier} hard limit ${hardLimit} bytes. Trim less important entries and try again.`
  }
  if ((await deps.getUpdatedAt(tier)) !== ts.lastSeenUpdatedAt) {
    // Changed under us (likely by the background fork): make the agent
    // re-read so its merge is based on the latest content.
    ts.hasRead = false
    ts.lastSeenUpdatedAt = 0
    return 'Error: memory was modified after your last read (possibly by a background reflection task). Call read_user_memory again to see the latest content, merge your changes, and save again.'
  }
  await deps.write(tier, trimmed)
  ts.saved = true
  const owner = deps.owners[tier]
  return `OK: 已更新 ${owner.name}（${tier === 'group' ? '群' : 'uid'} ${owner.uid}）的${TIER_LABEL[tier]}（${size} 字节）。`
}
