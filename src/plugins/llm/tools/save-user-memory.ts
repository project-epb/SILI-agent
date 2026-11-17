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
  /** The session is a DM: only then may the private record be written. */
  isDirect: boolean
  owner: MemoryOwner
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
      '完整覆写触发这一轮的用户的一份记录（不是 patch）。每份每 turn 只能写一次，写之前必须先 `read_user_memory`；read 之后若被后台反思任务改过，会被乐观锁拒绝并要求重读。',
      '',
      '**选哪份**：',
      '- `private` 私密记录：只能在私聊里写。私聊里聊到的事默认记这里。',
      '- `shared` 共享记录：**所有群都可能看到**。只记本人亲口说过、可以公开的信息（称呼、爱好、在玩的游戏等）；私聊里的事除非用户明说可以公开，否则不搬进来。',
      '',
      '只根据本人自己说的话写他的记录；别人替他说的不算。这一轮里有别人插话时写入会被拒绝。',
      '',
      '**何时调**：用户主动声明的身份/强偏好/跨会话事实（"我叫 X"、"以后别叫我 Y"、"我是前端工程师"）。',
      '',
      '**何时不调**：闲聊里冒出的事实、本次任务进度、性格推断、已在记忆里、可立即重新发现的常识。',
      '',
      '**特别地**：用户要改 SILI 自己的人设/语气（"别俏皮"、"用敬语"）一律不记——SILI 有固定人设。区分点：改 SILI 本身（不记） vs 改 SILI 如何对待这个用户（可记，如"不喜欢被叫老板"）。',
      '',
      '**写法**（基于 read 现有结构增改）：',
      '- 按 `## 主题` 分组，一条一行，行首标日期和来源：`- [YYYY-MM-DD · 群：群名] ...`，私聊来的写 `私聊`。日期取最近 `<turn_context>` 的 `time`，群名取 `channel.name`',
      '- **声明式，不要命令式**：✓「用户偏好简洁回复」 ✗「回复要简洁」（命令式会被未来轮当指令执行）',
      '- 不要把 `<user_memory>` 标签和括号里的说明写进内容',
      '',
      `硬上限：private ${hardLimits.private} 字节，shared ${hardLimits.shared} 字节（UTF-8）；空白内容会被拒绝。`,
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        tier: {
          type: 'string',
          enum: [...MEMORY_TIERS],
          description: '写哪份记录：private（仅私聊）或 shared（所有群可见）。',
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
  if (tier !== 'private' && tier !== 'shared') {
    return 'Error: tool input field "tier" must be "private" or "shared".'
  }
  if (tier === 'private' && !deps.isDirect) {
    return 'Error: 私密记录只能在私聊里改。群里只能写共享记录（shared），而且只记可以公开的内容。'
  }
  if (state.othersSpoke) {
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
  return `OK: 已更新 ${deps.owner.name}（uid ${deps.owner.uid}）的${TIER_LABEL[tier]}（${size} 字节）。`
}
