import type { Context } from 'koishi'

/** In-memory dedup of webhook deliveries by x-github-delivery id. GitHub retries a failed
 * delivery with the SAME id, so a first-seen check drops duplicate processing. Entries expire
 * after ttl. Lost on restart (fine — retries happen within minutes). An empty id is never
 * deduped: a missing delivery id must still be processed. */
export class DedupStore {
  private seen = new Set<string>()

  constructor(private ctx: Context, private ttl: number) {}

  /** True the first time an id is seen (records it + schedules expiry); false on repeats. */
  firstSeen(id: string): boolean {
    if (id && this.seen.has(id)) return false
    if (id) {
      this.seen.add(id)
      this.ctx.setTimeout(() => this.seen.delete(id), this.ttl)
    }
    return true
  }
}
