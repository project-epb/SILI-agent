import type { Logger, Session } from 'koishi'

/** A message that arrived while a turn of its conversation was running. */
export interface SteerItem {
  session: Session
  prompt: string
  /** The message's own turn_context + user_message envelope. */
  envelope: string
  /** Images whose pixels go with the envelope. */
  images?: string[]
}

/**
 * Live state for one in-flight chat turn. The `sendFromIndex` ref is
 * shared with the chat action's flush loop — reading `.value` from
 * outside lets a second `;chat` decide whether the user has already
 * seen any text (`> 0` → mid-stream interrupt) or not (`=== 0` →
 * pre-stream, prompts can be merged silently).
 */
export interface ActiveChatEntry {
  abort: AbortController
  sendFromIndex: { value: number }
  pendingUserPrompt: string
  /** Resolves when the chat action's finally block has finished cleanup. */
  completion: Promise<void>
  /**
   * Conversation id this chat is writing to. Carrying it on the entry
   * (instead of re-deriving from user.openai_last_conversation_id) avoids
   * a race when an interrupting chat enters before the prior action has
   * persisted its user-field write.
   */
  conversationId: string
  /**
   * Messages waiting to be steered into this turn. The agent loop drains
   * it after each tool iteration; what is left when the turn ends runs as
   * the next turn, unless the turn was stopped.
   */
  inbox: SteerItem[]
  /**
   * The turn stored an assistant or tool row. An interrupted turn that did
   * keeps its rows in history, so the interrupting turn must not merge its
   * prompt in again.
   */
  wroteRecords: boolean
  /** Platform user id of whoever started the turn: may stop it in a group. */
  starterUserId: string
}

export type AbortReason = 'user-stop' | 'user-reset' | 'user-interrupt'

/**
 * Per-user registry of in-flight chat turns. Replaces the older
 * CONVERSATION_LOCKS Set: instead of hard-rejecting the second `;chat`
 * we let the chat action read the existing entry and decide how to
 * interrupt (pre-stream merge vs mid-stream replace).
 *
 * Cleanup is owned by the chat action's finally block, not the abort
 * caller — the action still has post-abort work (resolveCompletion,
 * emoji reaction, etc.) before the entry can be removed.
 */
export class ActiveChatRegistry {
  private readonly entries = new Map<string | number, ActiveChatEntry>()
  /** Steered messages handed to the next turn (see SteerItem). */
  private readonly backlogs = new Map<string | number, SteerItem[]>()

  constructor(private readonly logger: Logger) {}

  get(userId: string | number): ActiveChatEntry | undefined {
    return this.entries.get(userId)
  }

  register(userId: string | number, entry: ActiveChatEntry): void {
    this.entries.set(userId, entry)
  }

  unregister(userId: string | number): void {
    this.entries.delete(userId)
  }

  putBacklog(key: string | number, items: SteerItem[]): void {
    this.backlogs.set(key, [...(this.backlogs.get(key) ?? []), ...items])
  }

  hasBacklog(key: string | number): boolean {
    return !!this.backlogs.get(key)?.length
  }

  takeBacklog(key: string | number): SteerItem[] {
    const items = this.backlogs.get(key) ?? []
    this.backlogs.delete(key)
    return items
  }

  /**
   * Abort the user's currently-active chat session if any. Returns true
   * if something was aborted, false if nothing was active. Shared entry
   * point for `;chat` self-interrupt, `llm.stop`, and `llm.reset`.
   */
  abort(userId: string | number, reason: AbortReason): boolean {
    const active = this.entries.get(userId)
    if (!active) return false
    this.logger.info('[chat] abort active session: reason=%s', reason)
    active.abort.abort(reason)
    return true
  }
}
