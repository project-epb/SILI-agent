export type HistoryRole = 'system' | 'user' | 'assistant' | 'tool'

/**
 * Stored on a turn's user row. `running` is written when the turn starts and
 * replaced when it ends; one still `running` on read-back was cut short by a
 * crash or restart. Rows from before the column existed have none: they were
 * only ever written by finished turns, so they read as `done`.
 */
export type TurnStatus = 'running' | 'done' | 'aborted' | 'failed'

export interface HistoryRow {
  role: HistoryRole
  content: string
  reasoning_content?: string
  tool_calls?: string             // JSON string
  tool_call_id?: string
  tool_name?: string
  turn_status?: TurnStatus | string
}

interface Turn {
  user: HistoryRow
  intermediate: HistoryRow[]      // assistant(tool_calls) + tool messages
  finalAssistant: HistoryRow | null
}

/**
 * What the model is told about a turn that did not finish. Short lines it has
 * seen a great deal of — Claude Code's wording for a user interrupt, the same
 * shape for an error. Do not explain them or name the cause: longer notes
 * confused models in only-chat. The tool line is never phrased as the tool
 * failing, or the model learns to avoid a tool that did nothing wrong.
 */
export const INTERRUPT_NOTES = {
  aborted: {
    user: '[Request interrupted by user]',
    tool: '[Request interrupted by user for tool use]',
  },
  failed: {
    user: '[Request interrupted by an error]',
    tool: '[Request interrupted by an error during tool use]',
  },
} as const

type Note = (typeof INTERRUPT_NOTES)[keyof typeof INTERRUPT_NOTES]

function noteFor(status: HistoryRow['turn_status']): Note | null {
  if (status === undefined || status === 'done') return null
  if (status === 'aborted') return INTERRUPT_NOTES.aborted
  return INTERRUPT_NOTES.failed
}

function toolCallsOf(row: HistoryRow): Array<{ id: string; name: string }> | null {
  if (row.role !== 'assistant' || !row.tool_calls) return null
  try {
    const arr = JSON.parse(row.tool_calls)
    return Array.isArray(arr) && arr.length > 0 ? arr : null
  } catch {
    return null
  }
}

function* groupTurns(rows: HistoryRow[]): Generator<Turn> {
  let i = 0
  while (i < rows.length) {
    const row = rows[i]
    if (row.role !== 'user') {
      i++
      continue
    }
    const turn: Turn = { user: row, intermediate: [], finalAssistant: null }
    i++
    while (i < rows.length && rows[i].role !== 'user') {
      const next = rows[i]
      if (next.role === 'assistant' && !toolCallsOf(next)) {
        turn.finalAssistant = next
        i++
        break
      }
      turn.intermediate.push(next)
      i++
    }
    yield turn
  }
}

function isValidTurn(turn: Turn): boolean {
  if (!turn.finalAssistant) return false
  // intermediate 必须成对：每个 assistant(tool_calls) 后都有对应的 tool 响应
  const pendingIds = new Set<string>()
  for (const row of turn.intermediate) {
    if (row.role === 'assistant') {
      const calls = toolCallsOf(row)
      if (!calls) return false
      for (const c of calls) pendingIds.add(c.id)
    } else if (row.role === 'tool') {
      if (!row.tool_call_id || !pendingIds.has(row.tool_call_id)) return false
      pendingIds.delete(row.tool_call_id)
    } else {
      return false
    }
  }
  return pendingIds.size === 0
}

/**
 * Rows of a turn that did not finish, made legal: every tool call gets a
 * result (a placeholder where none was stored), results with no call are
 * dropped, and the turn may end without a final reply. Nothing here is
 * written back, so a result that lands later replaces the placeholder.
 */
function repairTurn(turn: Turn, note: Note): HistoryRow[] {
  const out: HistoryRow[] = [turn.user]
  const pending = new Map<string, string>()
  const answerPending = () => {
    for (const [id, name] of pending)
      out.push({ role: 'tool', content: note.tool, tool_call_id: id, tool_name: name })
    pending.clear()
  }
  for (const row of turn.intermediate) {
    const calls = toolCallsOf(row)
    if (calls) {
      answerPending()
      out.push(row)
      for (const c of calls) pending.set(c.id, c.name)
    } else if (row.role === 'tool' && row.tool_call_id && pending.has(row.tool_call_id)) {
      out.push(row)
      pending.delete(row.tool_call_id)
    }
  }
  answerPending()
  if (turn.finalAssistant) out.push(turn.finalAssistant)
  return out
}

export interface History {
  rows: HistoryRow[]
  /**
   * The note owed to the next user message when the last turn did not
   * finish; the caller puts it in front of what it sends, never in what it
   * stores, so replay derives the same bytes.
   */
  pendingNote: string | null
}

/**
 * The last `userTurnLimit` turns, ready to send. Finished turns pass only when
 * complete; unfinished ones are repaired, and the user message after them
 * starts with their note. Notes are worked out over every row before trimming,
 * so a message reads the same however far the window has slid.
 */
export function buildHistory(rows: HistoryRow[], userTurnLimit: number): History {
  const turns: HistoryRow[][] = []
  let pendingNote: string | null = null
  for (const turn of groupTurns(rows)) {
    const note = noteFor(turn.user.turn_status)
    if (!note && !isValidTurn(turn)) continue
    const user = pendingNote
      ? { ...turn.user, content: `${pendingNote}\n\n${turn.user.content}` }
      : turn.user
    const fixed = { ...turn, user }
    turns.push(
      note
        ? repairTurn(fixed, note)
        : [user, ...turn.intermediate, turn.finalAssistant!]
    )
    pendingNote = note?.user ?? null
  }
  const kept = userTurnLimit <= 0 ? [] : turns.slice(-userTurnLimit)
  return { rows: kept.flat(), pendingNote }
}

export function groupAndTrimHistory(
  rows: HistoryRow[],
  userTurnLimit: number
): HistoryRow[] {
  return buildHistory(rows, userTurnLimit).rows
}
