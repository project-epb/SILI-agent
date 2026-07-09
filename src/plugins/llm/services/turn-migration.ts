import type { Context, Logger } from '@koishijs/core'

interface RawRow {
  id: number
  conversation_id: string
  role: string
  time: number
  turn_number?: number
  intra_turn_seq?: number
  tool_calls?: string
}

/**
 * Result summary, returned for logging.
 */
export interface MigrationResult {
  scannedConversations: number
  migratedRows: number
  skippedConversations: number
}

function isAssistantWithToolCalls(row: RawRow): boolean {
  if (row.role !== 'assistant') return false
  const tc = (row as any).tool_calls
  if (!tc) return false
  try {
    const arr = JSON.parse(tc)
    return Array.isArray(arr) && arr.length > 0
  } catch {
    return false
  }
}

function isPlainAssistant(row: RawRow): boolean {
  return row.role === 'assistant' && !isAssistantWithToolCalls(row)
}

/**
 * Pure: assign (turn_number, intra_turn_seq) to an ordered list of rows
 * within one conversation, with a FIFO heuristic that recovers correct
 * turn boundaries even from legacy data where wall-clock interleaving
 * placed a later turn's user row before the earlier turn's interrupted
 * assistant (the original race that motivated this whole rework).
 *
 * Algorithm
 * ---------
 * Walk rows in (time asc, id asc) order. Each user row opens a new
 * turn and joins a FIFO queue of "turns waiting for their final
 * assistant." Each plain assistant pops the head — this pairs the
 * EARLIEST user with the FIRST final-assistant we see, regardless of
 * how many other user rows interleaved before that assistant landed.
 *
 * Concrete example (the legacy interrupt sequence):
 *   user_A "再给 fiber"             →  push  [A]
 *   user_B "听困了"                  →  push  [A, B]
 *   plain assistant (Fiber, broken) →  pop A → final of turn 1
 *   plain assistant (好好好)         →  pop B → final of turn 2
 * Result: turn 1 = user_A + Fiber段, turn 2 = user_B + 好好好.
 * groupTurns later sees both turns as well-formed.
 *
 * Tool-related rows (assistant with tool_calls, tool result) are NOT
 * pulled from the FIFO — they belong to the most-recently-opened turn
 * that's still waiting for a final assistant (i.e. queue tail). This
 * matches the actual chat-loop semantics: tool calls always belong to
 * the chat invocation that triggered them, never to a later one.
 *
 * Edges:
 *   - Orphan plain assistant before any user → placeholder turn 1.
 *   - Orphan user with no later final assistant → turn just stays
 *     "user-only"; groupTurns drops it.
 */
export function assignTurnNumbers(
  rowsAsc: RawRow[]
): Array<{ id: number; turn_number: number; intra_turn_seq: number }> {
  const out: Array<{ id: number; turn_number: number; intra_turn_seq: number }> = []

  // Per-turn metadata: the user is intra_turn_seq=0; subsequent rows in
  // the same turn (intermediates and final assistant) get 1, 2, 3 by
  // append order. We materialize seq by tracking a counter per turn.
  const turnSeq = new Map<number, number>() // turn_number → next seq to assign
  const assignment = new Map<number, { turn_number: number; intra_turn_seq: number }>()

  let nextTurn = 0
  const waitingForFinal: number[] = [] // FIFO of turn_numbers that haven't seen a final assistant yet

  const openTurn = (row: RawRow): number => {
    const t = ++nextTurn
    turnSeq.set(t, 1) // user occupies seq 0; intermediates start at 1
    assignment.set(row.id, { turn_number: t, intra_turn_seq: 0 })
    waitingForFinal.push(t)
    return t
  }

  const placeIntermediate = (row: RawRow): void => {
    let t = waitingForFinal[waitingForFinal.length - 1]
    if (t === undefined) {
      // Orphan intermediate — open a placeholder turn carrying it.
      t = ++nextTurn
      turnSeq.set(t, 0)
      waitingForFinal.push(t)
    }
    const seq = turnSeq.get(t) ?? 0
    turnSeq.set(t, seq + 1)
    assignment.set(row.id, { turn_number: t, intra_turn_seq: seq })
  }

  const placeFinal = (row: RawRow): void => {
    let t = waitingForFinal.shift() // FIFO: oldest waiting turn gets this final
    if (t === undefined) {
      // Orphan plain assistant — open a placeholder turn just for it.
      t = ++nextTurn
      turnSeq.set(t, 1)
      assignment.set(row.id, { turn_number: t, intra_turn_seq: 0 })
      return
    }
    const seq = turnSeq.get(t) ?? 0
    turnSeq.set(t, seq + 1)
    assignment.set(row.id, { turn_number: t, intra_turn_seq: seq })
  }

  for (const row of rowsAsc) {
    if (row.role === 'user') {
      openTurn(row)
    } else if (isPlainAssistant(row)) {
      placeFinal(row)
    } else {
      // assistant with tool_calls, or tool result
      placeIntermediate(row)
    }
  }

  for (const row of rowsAsc) {
    const a = assignment.get(row.id)
    if (a) out.push({ id: row.id, ...a })
  }
  return out
}

/**
 * One-shot migration: scan all `openai_chat` rows, assign turn_number /
 * intra_turn_seq to any row that doesn't have them yet (turn_number is
 * 0 or null), in batches per conversation_id.
 *
 * Idempotent: a conversation whose every row already has turn_number > 0
 * is skipped without writing.
 */
export async function migrateTurnNumbers(
  ctx: Context,
  logger: Logger
): Promise<MigrationResult> {
  const allRows = (await ctx.database.get(
    'openai_chat',
    {},
    {
      fields: [
        'id',
        'conversation_id',
        'role',
        'time',
        'turn_number',
        'tool_calls',
      ],
    }
  )) as RawRow[] | null

  if (!allRows || allRows.length === 0) {
    return { scannedConversations: 0, migratedRows: 0, skippedConversations: 0 }
  }

  // Group by conversation_id
  const byConv = new Map<string, RawRow[]>()
  for (const row of allRows) {
    const list = byConv.get(row.conversation_id) ?? []
    list.push(row)
    byConv.set(row.conversation_id, list)
  }

  let migratedRows = 0
  let skippedConversations = 0

  for (const [convId, rows] of byConv) {
    // Skip conversations where every row already has turn_number assigned
    const needsWork = rows.some(
      (r) => r.turn_number == null || r.turn_number === 0
    )
    if (!needsWork) {
      skippedConversations += 1
      continue
    }

    rows.sort((a, b) => a.time - b.time || a.id - b.id)
    const assignments = assignTurnNumbers(rows)

    for (const a of assignments) {
      await ctx.database.set(
        'openai_chat',
        { id: a.id },
        { turn_number: a.turn_number, intra_turn_seq: a.intra_turn_seq }
      )
      migratedRows += 1
    }
    logger.info(
      '[turn-migration] %s: migrated %d rows, max turn=%d',
      convId,
      assignments.length,
      assignments.length ? assignments[assignments.length - 1].turn_number : 0
    )
  }

  return {
    scannedConversations: byConv.size,
    migratedRows,
    skippedConversations,
  }
}
