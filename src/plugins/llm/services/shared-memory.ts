import { Context } from 'koishi'

import { byteLength } from './memory'

declare module 'koishi' {
  interface Tables {
    openai_user_shared_memory: OpenAIUserSharedMemory
  }
}

/**
 * A user's shared record: public facts about them that may be read and
 * written in any group. Their private record (`openai_user_memory`) never
 * leaves DMs.
 */
export interface OpenAIUserSharedMemory {
  id: number
  platform: string
  user_id: string
  content: string
  byte_size: number
  last_updated_at: number
  update_count: number
}

export class SharedMemoryStore {
  constructor(private ctx: Context) {}

  static initSchema(ctx: Context): void {
    ctx.model.extend(
      'openai_user_shared_memory',
      {
        id: 'unsigned',
        platform: 'string(64)',
        user_id: 'string(128)',
        content: 'text',
        byte_size: 'unsigned',
        last_updated_at: 'unsigned(20)',
        update_count: 'unsigned',
      },
      {
        primary: 'id',
        autoInc: true,
        unique: [['platform', 'user_id']],
      }
    )
  }

  async getMeta(
    platform: string,
    userId: string
  ): Promise<OpenAIUserSharedMemory | null> {
    const rows = await this.ctx.database.get('openai_user_shared_memory', {
      platform,
      user_id: userId,
    })
    return rows[0] ?? null
  }

  async set(platform: string, userId: string, content: string): Promise<void> {
    const now = Date.now()
    const existing = await this.getMeta(platform, userId)
    if (existing) {
      await this.ctx.database.set(
        'openai_user_shared_memory',
        { id: existing.id },
        {
          content,
          byte_size: byteLength(content),
          last_updated_at: now,
          update_count: existing.update_count + 1,
        }
      )
    } else {
      await this.ctx.database.create('openai_user_shared_memory', {
        platform,
        user_id: userId,
        content,
        byte_size: byteLength(content),
        last_updated_at: now,
        update_count: 1,
      })
    }
  }

  async delete(platform: string, userId: string): Promise<boolean> {
    const existing = await this.getMeta(platform, userId)
    if (!existing) return false
    await this.ctx.database.remove('openai_user_shared_memory', { id: existing.id })
    return true
  }
}
