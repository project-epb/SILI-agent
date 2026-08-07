import type { Context } from 'koishi'
import type { ActionMap } from './actions'

/** Table backing the cold layer. */
export const HISTORY_TABLE = 'github_history'

/** A pushed message's quick-reply context: the actions it supports + the
 * original body to quote (`> ...`) when a user replies with a comment. */
export interface HistoryEntry {
  actions: ActionMap
  body: string
}

declare module 'koishi' {
  interface Tables {
    github_history: {
      messageId: string
      actions: ActionMap
      body: string
      expireAt: Date
    }
  }
}

/**
 * Two-layer map: pushed message id → its quick-reply context.
 *
 * - **Hot (memory)**: `hotTtl` (config.replyTimeout, default 1h). `get()` is synchronous,
 *   so quoting a recent message costs nothing.
 * - **Cold (database)**: `coldTtl` (config.replyColdTimeout, default 7d). `fetch()` falls
 *   back here on a memory miss and warms the entry back in, so quoting a days-old message
 *   — or any message after a restart — still works.
 *
 * The layers expire independently: dropping an entry from memory does NOT delete its row.
 * Rows past their cold deadline are swept once at startup by `prune()`, so there is no cron
 * and no sweep interval.
 *
 * Every database call is best-effort: losing persistence must never cost a quick reply.
 */
export class HistoryStore {
  private map: Record<string, HistoryEntry> = Object.create(null)

  constructor(
    private ctx: Context,
    private hotTtl: number,
    private coldTtl: number
  ) {}

  private warn(e: any) {
    this.ctx.logger('github').warn(e)
  }

  /** Hold an entry in memory for `ms`, then drop it (the cold row stays). */
  private hold(messageIds: string[], entry: HistoryEntry, ms: number): void {
    for (const id of messageIds) this.map[id] = entry
    this.ctx.setTimeout(() => {
      for (const id of messageIds) delete this.map[id]
    }, ms)
  }

  /** Record the same context under each broadcast message id, in both layers.
   * No-op if there are no ids or no actions. */
  record(messageIds: string[], actions: ActionMap, body: string): void {
    if (!messageIds.length || !Object.keys(actions).length) return
    const entry: HistoryEntry = { actions, body }
    this.hold(messageIds, entry, this.hotTtl)
    const expireAt = new Date(Date.now() + this.coldTtl)
    // fire-and-forget: the broadcast already happened, nothing waits on this.
    Promise.resolve(
      this.ctx.database.upsert(
        HISTORY_TABLE,
        messageIds.map((messageId) => ({ messageId, actions, body, expireAt }))
      )
    ).catch((e) => this.warn(e))
  }

  /** Synchronous hot-layer read. */
  get(messageId: string): HistoryEntry | undefined {
    return this.map[messageId]
  }

  /** Hot read, falling back to the cold layer and warming the result back in. */
  async fetch(messageId: string): Promise<HistoryEntry | undefined> {
    const hot = this.map[messageId]
    if (hot) return hot
    let row: { actions: ActionMap; body: string; expireAt: Date } | undefined
    try {
      ;[row] = await this.ctx.database.get(HISTORY_TABLE, { messageId })
    } catch (e) {
      this.warn(e)
      return undefined
    }
    if (!row) return undefined
    // A row can outlive its deadline between two prunes; treat it as gone.
    const remaining = +row.expireAt - Date.now()
    if (remaining <= 0) return undefined
    const entry: HistoryEntry = { actions: row.actions, body: row.body }
    this.hold([messageId], entry, Math.min(this.hotTtl, remaining))
    return entry
  }

  /** Drop rows past their cold deadline. Called once on ready. */
  async prune(): Promise<void> {
    try {
      await this.ctx.database.remove(HISTORY_TABLE, { expireAt: { $lte: new Date() } })
    } catch (e) {
      this.warn(e)
    }
  }
}
