/**
 * Asks the model to say what it is doing when the user has seen nothing for
 * a while (Claude Code does the same). Each nudge costs a QQ reply — at most
 * 5 per user message — so they are sparse and capped per turn.
 */
export interface ProgressNudgeOptions {
  /** Silence before a nudge, in ms; 0 turns nudges off. */
  afterMs: number
  maxPerTurn: number
}

export function createProgressNudge(opts: ProgressNudgeOptions, now = Date.now) {
  let quietSince = now()
  let given = 0
  return {
    /** The user just saw something. */
    seen() {
      quietSince = now()
    },
    /** Whether to nudge now; a nudge restarts the silence count. */
    take(): boolean {
      if (opts.afterMs <= 0 || given >= opts.maxPerTurn) return false
      if (now() - quietSince < opts.afterMs) return false
      given++
      quietSince = now()
      return true
    },
  }
}
