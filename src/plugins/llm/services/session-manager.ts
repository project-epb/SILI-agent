import { Context } from '@koishijs/core'

declare module 'koishi' {
  interface Tables {
    openai_session: OpenAISession
  }
}

export interface OpenAISession {
  id: number
  conversation_id: string
  conversation_owner: number
  platform: string
  user_id: string
  started_at: number
  /** Last time this session was used; the session is considered fresh until
   *  now - last_used_at exceeds the configured idle timeout. */
  last_used_at: number
  /** First user utterance (up to 30 codepoints) — used as a label when the
   *  user wants to resume / pick between past conversations. */
  user_first_msg: string
  /**
   * If non-empty, this session was created by SummaryCompactor from another
   * session — the value is that prior session's `conversation_id`. Lets
   * tooling walk the summary chain backward and tells the operator this
   * is a continuation, not a fresh start.
   */
  prev_session_id?: string
}

export interface CreateSessionInput {
  conversationId: string
  conversationOwner: number
  platform: string
  userId: string
  userFirstMsg: string
  /** When this session was forked from another (summary compaction). */
  prevSessionId?: string
}

const FIRST_MSG_MAX_CODEPOINTS = 30

/** Take the first N codepoints of a string (emoji/中文 safe). */
export function truncateFirstMsg(text: string): string {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return ''
  const points = [...trimmed]
  return points.length <= FIRST_MSG_MAX_CODEPOINTS
    ? trimmed
    : points.slice(0, FIRST_MSG_MAX_CODEPOINTS).join('')
}

export class SessionManager {
  constructor(private ctx: Context) {}

  static initSchema(ctx: Context): void {
    ctx.model.extend(
      'openai_session',
      {
        id: 'unsigned',
        conversation_id: 'string(64)',
        conversation_owner: 'integer',
        platform: 'string(64)',
        user_id: 'string(128)',
        started_at: 'unsigned(20)',
        last_used_at: 'unsigned(20)',
        user_first_msg: 'string(255)',
        prev_session_id: 'string(64)',
      },
      {
        primary: 'id',
        autoInc: true,
        unique: [['conversation_id']],
        indexes: [['conversation_owner', 'started_at']],
      }
    )
  }

  async get(conversationId: string): Promise<OpenAISession | null> {
    const rows = await this.ctx.database.get('openai_session', {
      conversation_id: conversationId,
    })
    return rows[0] ?? null
  }

  async create(input: CreateSessionInput): Promise<OpenAISession> {
    const now = Date.now()
    const row = await this.ctx.database.create('openai_session', {
      conversation_id: input.conversationId,
      conversation_owner: input.conversationOwner,
      platform: input.platform,
      user_id: input.userId,
      started_at: now,
      last_used_at: now,
      user_first_msg: truncateFirstMsg(input.userFirstMsg),
      prev_session_id: input.prevSessionId ?? '',
    })
    return row
  }

  /** Bump last_used_at to "now" (fire-and-forget; failures are non-fatal). */
  async touch(sessionRowId: number): Promise<void> {
    await this.ctx.database.set(
      'openai_session',
      { id: sessionRowId },
      { last_used_at: Date.now() }
    )
  }

  /**
   * Fetch the active session for a conversation_id, honoring the idle
   * timeout. Returns one of:
   *   - { session, expired: false } — fresh session, safe to reuse
   *   - { session: null, expired: true } — session exists but stale; caller
   *     should rotate (issue a new conversation_id and create a new session)
   *   - { session: null, expired: false } — no session at all yet
   */
  async getActive(
    conversationId: string,
    idleTtlMs: number
  ): Promise<{ session: OpenAISession | null; expired: boolean }> {
    const row = await this.get(conversationId)
    if (!row) return { session: null, expired: false }
    if (isSessionExpired(row, idleTtlMs)) {
      return { session: null, expired: true }
    }
    return { session: row, expired: false }
  }
}

/** Pure helper so it can be unit-tested without a koishi context. */
export function isSessionExpired(
  session: Pick<OpenAISession, 'last_used_at'>,
  idleTtlMs: number,
  now: number = Date.now()
): boolean {
  if (idleTtlMs <= 0) return false // 0 / negative disables expiry
  return now - session.last_used_at > idleTtlMs
}
