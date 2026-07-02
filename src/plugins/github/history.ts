import type { Context } from 'koishi'
import type { ActionMap } from './actions'

/** In-memory map: pushed message id → the quick-reply actions it supports. Entries
 * expire after `ttl` (config.replyTimeout, default 1h). Lost on process restart —
 * matches the old plugin; no DB table. */
export class HistoryStore {
  private map: Record<string, ActionMap> = Object.create(null)

  constructor(private ctx: Context, private ttl: number) {}

  /** Record the same actions under each broadcast message id + schedule expiry.
   * No-op if there are no ids or no actions. */
  record(messageIds: string[], actions: ActionMap): void {
    if (!messageIds.length || !Object.keys(actions).length) return
    for (const id of messageIds) this.map[id] = actions
    this.ctx.setTimeout(() => {
      for (const id of messageIds) delete this.map[id]
    }, this.ttl)
  }

  get(messageId: string): ActionMap | undefined {
    return this.map[messageId]
  }
}
