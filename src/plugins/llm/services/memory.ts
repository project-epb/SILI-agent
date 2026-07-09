import { Context } from '@koishijs/core'

declare module 'koishi' {
  interface Tables {
    openai_user_memory: OpenAIUserMemory
  }
}

export interface OpenAIUserMemory {
  id: number
  platform: string
  user_id: string
  content: string
  byte_size: number
  last_updated_at: number
  last_check_at: number
  update_count: number
  message_count_at_update: number
  /**
   * conversation_id under which message_count_at_update was recorded.
   * Used by the scheduler to detect session rotation: when the current
   * conversation_id differs, the stored count is treated as 0 so the
   * "every N messages in current session" semantics survive across
   * idle-timeout-driven session rollover.
   */
  last_forked_conversation_id: string
}

export const NO_UPDATE_MAGIC = '<<NO_UPDATE>>'

export function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

export function isNoUpdateMagic(text: string): boolean {
  return text.trim() === NO_UPDATE_MAGIC
}

export class MemoryStore {
  constructor(private ctx: Context) {}

  static initSchema(ctx: Context): void {
    ctx.model.extend(
      'openai_user_memory',
      {
        id: 'unsigned',
        platform: 'string(64)',
        user_id: 'string(128)',
        content: 'text',
        byte_size: 'unsigned',
        last_updated_at: 'unsigned(20)',
        last_check_at: 'unsigned(20)',
        update_count: 'unsigned',
        message_count_at_update: 'unsigned',
        last_forked_conversation_id: 'string',
      },
      {
        primary: 'id',
        autoInc: true,
        unique: [['platform', 'user_id']],
      }
    )
  }

  async get(platform: string, userId: string): Promise<string> {
    const meta = await this.getMeta(platform, userId)
    return meta?.content ?? ''
  }

  async getMeta(
    platform: string,
    userId: string
  ): Promise<OpenAIUserMemory | null> {
    const rows = await this.ctx.database.get('openai_user_memory', {
      platform,
      user_id: userId,
    })
    return rows[0] ?? null
  }

  async set(
    platform: string,
    userId: string,
    content: string,
    currentMessageCount: number,
    conversationId: string
  ): Promise<void> {
    const now = Date.now()
    const existing = await this.getMeta(platform, userId)
    if (existing) {
      await this.ctx.database.set(
        'openai_user_memory',
        { id: existing.id },
        {
          content,
          byte_size: byteLength(content),
          last_updated_at: now,
          last_check_at: now,
          update_count: existing.update_count + 1,
          message_count_at_update: currentMessageCount,
          last_forked_conversation_id: conversationId,
        }
      )
    } else {
      await this.ctx.database.create('openai_user_memory', {
        platform,
        user_id: userId,
        content,
        byte_size: byteLength(content),
        last_updated_at: now,
        last_check_at: now,
        update_count: 1,
        message_count_at_update: currentMessageCount,
        last_forked_conversation_id: conversationId,
      })
    }
  }

  async delete(platform: string, userId: string): Promise<boolean> {
    const existing = await this.getMeta(platform, userId)
    if (!existing) return false
    await this.ctx.database.remove('openai_user_memory', { id: existing.id })
    return true
  }

  async markChecked(
    platform: string,
    userId: string,
    currentMessageCount: number,
    conversationId: string
  ): Promise<void> {
    const now = Date.now()
    const existing = await this.getMeta(platform, userId)
    if (existing) {
      await this.ctx.database.set(
        'openai_user_memory',
        { id: existing.id },
        {
          last_check_at: now,
          message_count_at_update: currentMessageCount,
          last_forked_conversation_id: conversationId,
        }
      )
    } else {
      await this.ctx.database.create('openai_user_memory', {
        platform,
        user_id: userId,
        content: '',
        byte_size: 0,
        last_updated_at: 0,
        last_check_at: now,
        update_count: 0,
        message_count_at_update: currentMessageCount,
        last_forked_conversation_id: conversationId,
      })
    }
  }
}
