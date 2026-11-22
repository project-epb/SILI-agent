import { byteLength } from '../services/memory'
import type { ToolDefinition } from '../providers/_base'

/**
 * Three records. A user's `private` one (openai_user_memory) is read and
 * written in DMs only; their `shared` one (openai_user_shared_memory) holds
 * what may be seen in any group; a group's `group` one (openai_group_memory)
 * belongs to that group and is only read there.
 */
export type MemoryTier = 'private' | 'shared' | 'group'

export const MEMORY_TIERS: readonly MemoryTier[] = ['private', 'shared', 'group']

export const READ_USER_MEMORY_TOOL: ToolDefinition = {
  name: 'read_user_memory',
  description:
    '读取长期记忆：私聊里返回私密 + 共享记录，群里返回共享记录 + 群记忆，每份用 `<user_memory>` 包着，标明主人和档位。打算用 `save_user_memory` 更新某份记录前必须先读（写入会校验）。',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
}

/** Per-tier coordination between read_user_memory and save_user_memory. */
export interface MemoryTierState {
  /** This tier was read in the current turn. */
  hasRead: boolean
  /**
   * `last_updated_at` seen at the most recent read: the optimistic-lock
   * token that lets save detect a write in between (e.g. the background
   * fork). 0 = no record existed yet.
   */
  lastSeenUpdatedAt: number
  /** This tier was already saved in the current turn. */
  saved: boolean
}

/**
 * Per-turn memory tool state. Lives in the agent loop's `turnState`; the
 * chat command sets `othersSpoke` when the turn carries someone else's
 * message (a steer or a backlog).
 */
export interface MemoryToolState {
  private: MemoryTierState
  shared: MemoryTierState
  group: MemoryTierState
  /**
   * This turn carries messages from someone other than the user it belongs
   * to. Writes to that user's records are refused: whoever steered in could
   * otherwise put words into them. The group's own memory is unaffected.
   */
  othersSpoke: boolean
}

/** Stable key under `ToolContext.turnState` for memory tools. */
export const MEMORY_TOOL_STATE_KEY = 'memory'

export function getMemoryToolState(
  turnState: Record<string, unknown>
): MemoryToolState {
  let s = turnState[MEMORY_TOOL_STATE_KEY] as MemoryToolState | undefined
  if (!s) {
    const tier = (): MemoryTierState => ({
      hasRead: false,
      lastSeenUpdatedAt: 0,
      saved: false,
    })
    s = { private: tier(), shared: tier(), group: tier(), othersSpoke: false }
    turnState[MEMORY_TOOL_STATE_KEY] = s
  }
  return s
}

/**
 * Tiers this session may read and write: the private record only in a DM,
 * the group's memory only in a group.
 */
export function readableTiers(isDirect: boolean): MemoryTier[] {
  return isDirect ? ['private', 'shared'] : ['shared', 'group']
}

/** Who a record belongs to, as shown to the model. */
export interface MemoryOwner {
  name: string
  uid: string
}

/**
 * Records a fresh conversation is seeded with. A group's shared conversation
 * carries only that group's memory: several people talk in it, so nobody's
 * own record goes in up front.
 */
export function snapshotTiers(
  isDirect: boolean,
  sharedConversation: boolean
): MemoryTier[] {
  return sharedConversation ? ['group'] : readableTiers(isDirect)
}

const TIER_NOTE: Record<MemoryTier, string> = {
  private: '私密记录：只在私聊里用，不要转述给第三方。',
  shared: '共享记录：所有群都可能看到。',
  group: '群记忆：本群共有，只在本群用。',
}

export const TIER_LABEL: Record<MemoryTier, string> = {
  private: '私密记录',
  shared: '共享记录',
  group: '群记忆',
}

/**
 * One record wrapped with its owner and tier, so a model reading several
 * people's messages never mixes up whose record it is.
 */
export function renderMemoryBlock(
  owner: MemoryOwner,
  tier: MemoryTier,
  body: string
): string {
  const name = owner.name.replace(/"/g, "'")
  return [
    `<user_memory owner="${name}" uid="${owner.uid}" tier="${tier}">`,
    `（${owner.name}的${TIER_NOTE[tier]}）`,
    body,
    '</user_memory>',
  ].join('\n')
}

/**
 * The body of one record: its content, plus how much of the limit it uses
 * when `hardLimit` is given (an abstract "3300 字节" without a current-usage
 * anchor is easy for the agent to misjudge). Returns `last_updated_at` for
 * the optimistic lock.
 */
export async function runReadUserMemory(
  memory: { getMeta(platform: string, userId: string): Promise<{ content: string; last_updated_at: number } | null> },
  platform: string,
  userId: string,
  options: { hardLimit?: number } = {}
): Promise<{ text: string; lastUpdatedAt: number }> {
  const meta = await memory.getMeta(platform, userId)
  const raw = meta?.content
  const lastUpdatedAt = meta?.last_updated_at ?? 0
  if (!raw || !raw.trim()) {
    return { text: '(暂无记录)', lastUpdatedAt }
  }
  let text = raw
  if (options.hardLimit && options.hardLimit > 0) {
    // Size matches what save_user_memory / memory-fork actually persist
    // (trailing whitespace trimmed).
    const trimmed = raw.replace(/\s+$/, '')
    const size = byteLength(trimmed)
    const pct = Math.round((size / options.hardLimit) * 100)
    text = `${trimmed}\n\n(已用 ${size} / ${options.hardLimit} 字节，约 ${pct}% 配额)`
  }
  return { text, lastUpdatedAt }
}
