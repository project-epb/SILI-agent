/**
 * Asks the model to say what it is doing when the user has seen nothing for
 * a while or for several tool calls (Claude Code's silent-turn reminder).
 */
export interface ProgressNudgeOptions {
  /** Silence before a nudge, in ms; 0 disables the time trigger. */
  afterMs: number
  /** Tool calls without visible text before a nudge; 0 disables this trigger. */
  afterToolCalls: number
}

export function createProgressNudge(opts: ProgressNudgeOptions, now = Date.now) {
  let quietSince = now()
  let quietCalls = 0
  const restart = () => {
    quietSince = now()
    quietCalls = 0
  }
  return {
    /** The user just saw something. */
    seen: restart,
    /**
     * Record `toolCalls` more calls and say whether to nudge now; a nudge
     * restarts both counts.
     */
    take(toolCalls: number): boolean {
      quietCalls += toolCalls
      const byTime = opts.afterMs > 0 && now() - quietSince >= opts.afterMs
      const byCalls =
        opts.afterToolCalls > 0 && quietCalls >= opts.afterToolCalls
      if (!byTime && !byCalls) return false
      restart()
      return true
    },
  }
}
