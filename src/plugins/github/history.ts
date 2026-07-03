import type { Context } from 'koishi'
import type { ActionMap } from './actions'

/** A pushed message's quick-reply context: the actions it supports + the
 * original body to quote (`> ...`) when a user replies with a comment. */
export interface HistoryEntry {
  actions: ActionMap
  body: string
}

/** In-memory map: pushed message id → its quick-reply context. Entries expire
 * after `ttl` (config.replyTimeout, default 1h). Lost on process restart —
 * matches the old plugin; no DB table. */
export class HistoryStore {
  private map: Record<string, HistoryEntry> = Object.create(null)

  constructor(private ctx: Context, private ttl: number) {}

  /** Record the same context under each broadcast message id + schedule expiry.
   * No-op if there are no ids or no actions. */
  record(messageIds: string[], actions: ActionMap, body: string): void {
    if (!messageIds.length || !Object.keys(actions).length) return
    const entry: HistoryEntry = { actions, body }
    for (const id of messageIds) this.map[id] = entry
    this.ctx.setTimeout(() => {
      for (const id of messageIds) delete this.map[id]
    }, this.ttl)
  }

  get(messageId: string): HistoryEntry | undefined {
    return this.map[messageId]
  }
}
