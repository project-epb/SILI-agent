import { byteLength } from '../services/memory'
import type { ToolDefinition } from '../providers/_base'

/**
 * A user has two records. `private` (openai_user_memory) is read and written
 * in DMs only; `shared` (openai_user_shared_memory) holds what may be seen in
 * any group.
 */
export type MemoryTier = 'private' | 'shared'

export const MEMORY_TIERS: readonly MemoryTier[] = ['private', 'shared']

export const READ_USER_MEMORY_TOOL: ToolDefinition = {
  name: 'read_user_memory',
  description: [
    '读取触发这一轮的用户的长期记忆。每位用户有两份记录：',
    '- **私密记录**（private）：只在私聊里读写，内容不转述给第三方。',
    '- **共享记录**（shared）：可公开的信息，所有群都可能看到。',
    '',
    '私聊里返回两份，群里只返回共享记录。每份用 `<user_memory>` 包着，标明主人和档位。',
    '',
    '**何时调**：话题涉及该用户的偏好、过往互动、个人化判断时。',
    '**何时不调**：闲聊、常识问答、无需个人化的请求——浪费 turn。',
    '',
    '如果接下来打算调 `save_user_memory` 更新某份记录，必须先调本工具（save 会校验 read-before-write）。',
  ].join('\n'),
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
  /**
   * This turn carries messages from someone other than the user it belongs
   * to. Writes are refused: whoever steered in could otherwise put words
   * into this user's records.
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
    s = { private: tier(), shared: tier(), othersSpoke: false }
    turnState[MEMORY_TOOL_STATE_KEY] = s
  }
  return s
}

/** Tiers this session may read and write: private ones only in a DM. */
export function readableTiers(isDirect: boolean): MemoryTier[] {
  return isDirect ? ['private', 'shared'] : ['shared']
}

/** Who a record belongs to, as shown to the model. */
export interface MemoryOwner {
  name: string
  uid: string
}

const TIER_NOTE: Record<MemoryTier, string> = {
  private: '私密记录：只在私聊里用，不要转述给第三方。',
  shared: '共享记录：所有群都可能看到。',
}

export const TIER_LABEL: Record<MemoryTier, string> = {
  private: '私密记录',
  shared: '共享记录',
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
    `（${owner.name} 的${TIER_NOTE[tier]}）`,
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
