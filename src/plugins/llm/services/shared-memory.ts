import { Context } from 'koishi'

import { byteLength } from './memory'

declare module 'koishi' {
  interface Tables {
    openai_user_shared_memory: MemoryRecordRow
    openai_group_memory: MemoryRecordRow
  }
}

/**
 * One record of a shared or group memory. `owner_id` is a Koishi uid for a
 * user's shared record (public facts readable in any group) and a channel id
 * for a group's memory (only read in that group). A user's private record
 * (`openai_user_memory`) has its own table and never leaves DMs.
 */
export interface MemoryRecordRow {
  id: number
  platform: string
  owner_id: string
  content: string
  byte_size: number
  last_updated_at: number
  update_count: number
}

export type MemoryRecordTable = 'openai_user_shared_memory' | 'openai_group_memory'

export class MemoryRecordStore {
  constructor(
    private ctx: Context,
    readonly table: MemoryRecordTable
  ) {}

  static initSchema(ctx: Context, table: MemoryRecordTable): void {
    ctx.model.extend(
      table,
      {
        id: 'unsigned',
        platform: 'string(64)',
        owner_id: 'string(128)',
        content: 'text',
        byte_size: 'unsigned',
        last_updated_at: 'unsigned(20)',
        update_count: 'unsigned',
      },
      {
        primary: 'id',
        autoInc: true,
        unique: [['platform', 'owner_id']],
      }
    )
  }

  async getMeta(platform: string, ownerId: string): Promise<MemoryRecordRow | null> {
    const rows = await this.ctx.database.get(this.table, {
      platform,
      owner_id: ownerId,
    })
    return rows[0] ?? null
  }

  async set(platform: string, ownerId: string, content: string): Promise<void> {
    const now = Date.now()
    const existing = await this.getMeta(platform, ownerId)
    if (existing) {
      await this.ctx.database.set(
        this.table,
        { id: existing.id },
        {
          content,
          byte_size: byteLength(content),
          last_updated_at: now,
          update_count: existing.update_count + 1,
        }
      )
    } else {
      await this.ctx.database.create(this.table, {
        platform,
        owner_id: ownerId,
        content,
        byte_size: byteLength(content),
        last_updated_at: now,
        update_count: 1,
      })
    }
  }

  async delete(platform: string, ownerId: string): Promise<boolean> {
    const existing = await this.getMeta(platform, ownerId)
    if (!existing) return false
    await this.ctx.database.remove(this.table, { id: existing.id })
    return true
  }
}
