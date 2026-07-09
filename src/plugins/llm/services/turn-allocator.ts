import type { Context } from '@koishijs/core'

/**
 * Per-conversation monotonic turn-number allocator.
 *
 * Each chat invocation calls `allocate(conversation_id)` to get the
 * next integer for its turn (1, 2, 3, ...). The number is paired with
 * `intra_turn_seq` (assigned by the chat handler — user=0, then 1, 2,
 * ... for assistant/tool rows) to form the sort key for history.
 *
 * Design notes
 * ------------
 * - In-memory counter per conversation_id, lazily initialized from the
 *   db's current max(turn_number) the first time we see the id.
 * - Allocation is synchronous after init: `++counter`. This means even
 *   when an old chat hasn't persisted its `user` row yet, the next chat
 *   that calls `allocate` gets a strictly larger number — race against
 *   db state cannot collide because we never re-read max once
 *   initialized.
 * - The `ActiveChatRegistry` already serializes chat invocations per
 *   owner, so concurrent allocate() on the same conversation is rare,
 *   but we still guard via an in-flight init promise so two near-
 *   simultaneous first-time allocates share one db read.
 * - Single-process assumption: this service is the source of truth
 *   within one koishi process. Cross-process replicas would need an
 *   atomic counter in the db; we don't deploy that way.
 */
export class TurnAllocator {
  private readonly counters = new Map<string, number>()
  private readonly initialized = new Set<string>()
  private readonly initLocks = new Map<string, Promise<void>>()

  constructor(private readonly ctx: Context) {}

  async allocate(conversationId: string): Promise<number> {
    await this.ensureInitialized(conversationId)
    const next = (this.counters.get(conversationId) ?? 0) + 1
    this.counters.set(conversationId, next)
    return next
  }

  /**
   * Peek at the current counter without advancing. For tests/diagnostics.
   */
  peek(conversationId: string): number | undefined {
    return this.counters.get(conversationId)
  }

  /**
   * Drop in-memory state. Tests use this to simulate a fresh process;
   * production code should never call it (the counter is the source of
   * truth, dropping it risks turn-number collisions).
   */
  reset(): void {
    this.counters.clear()
    this.initialized.clear()
    this.initLocks.clear()
  }

  private async ensureInitialized(conversationId: string): Promise<void> {
    if (this.initialized.has(conversationId)) return

    let lock = this.initLocks.get(conversationId)
    if (!lock) {
      lock = this.doInit(conversationId)
      this.initLocks.set(conversationId, lock)
    }
    await lock
  }

  private async doInit(conversationId: string): Promise<void> {
    const rows = (await this.ctx.database.get(
      'openai_chat',
      { conversation_id: conversationId },
      {
        fields: ['turn_number'],
        sort: { turn_number: 'desc' },
        limit: 1,
      }
    )) as Array<{ turn_number?: number }> | null
    const max = rows?.[0]?.turn_number ?? 0
    this.counters.set(conversationId, max)
    this.initialized.add(conversationId)
    this.initLocks.delete(conversationId)
  }
}
