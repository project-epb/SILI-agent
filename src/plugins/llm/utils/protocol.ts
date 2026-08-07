/**
 * Protocol elements shared between the orchestration system and the agent.
 *
 * Centralized so any rename / addition is one-stop, and so plain `grep`
 * across the codebase finds every reference.
 *
 * Format split — important to understand:
 *  - **Inbound (system → agent)** uses `<turn_context>...</turn_context>`
 *    XML style envelope. These never reach the chat platform; they only
 *    exist in the agent's message context where AI is good at reading
 *    XML. The name `turn_context` (vs the older `chat_info`) is meant to
 *    signal to the model that fields here are LIVE PER-TURN state — values
 *    can change between turns (user moves channel, runs `;callme`, …) and
 *    that's expected, not an anomaly worth questioning.
 *  - **Outbound (agent → us → chat platform)** uses `[koishi:...]`
 *    bracket form for any protocol marker or real element the agent wants
 *    rendered. The sanitizer h.text()-escapes the *entire* agent output
 *    by default; only bracket-form patterns get lifted as elements or
 *    dropped as markers. This means raw `<` `>` in agent text never
 *    collide with our protocol — both can coexist because the protocol
 *    doesn't use angle brackets at all on the outbound side.
 *
 * Categories:
 *  - **Element type names**: bare `turn_context`, `user_message`, etc.
 *    Used for `h.parse(...).type` comparison on inbound envelope.
 *  - **Self-closing markers**: full `[koishi:silent]` strings the agent
 *    emits inline. Used by agent-loop and stream-splitter for detection.
 *  - **Block tags** (inbound only): paired open/close XML strings used
 *    to wrap envelope blocks in user messages.
 */

/** Element type names (`element.type` after `h.parse`). */
export const PROTOCOL_ELEMENT_TYPES = {
  /** Live per-turn metadata (time, channel). System-injected each turn. */
  TURN_CONTEXT: 'turn_context',
  /** The actual user-typed text inside a chat turn envelope. */
  USER_MESSAGE: 'user_message',
  /**
   * The message the user quote-replied to, when this turn has one. Carries the
   * author (and whether it was the bot herself) plus, on OneBot, the channel
   * history cursor so the agent can read around an old message.
   */
  QUOTED_MESSAGE: 'quoted_message',
  /** One-shot block telling the agent it was just interrupted. */
  INTERRUPT_NOTICE: 'interrupt_notice',
  /**
   * System-issued compaction request. Wraps the "please summarize"
   * instruction inside the synthetic summary user message produced by
   * SummaryCompactor — the wrapper signals to the model that this is
   * orchestration boilerplate, not the user actually asking for a recap.
   */
  SYSTEM_COMPACT: 'system_compact',
  /** Marker appended to assistant content when its turn was cut short. */
  INTERRUPTED: 'interrupted',
  /** Magic string the agent emits when it chooses silence. */
  SILENT: 'silent',
  /** Agent-inserted message-break point (drives stream chunk boundaries). */
  MSG_BREAK: 'msg_break',
} as const

/**
 * Full marker strings emitted by the agent on the outbound side. Bracket
 * form (`[koishi:xxx]`) deliberately avoids angle brackets so it never
 * collides with raw `<` / `>` in agent prose — the sanitizer h.text()-
 * escapes everything that doesn't match a `[koishi:...]` pattern, so the
 * protocol and natural text coexist without parsing ambiguity.
 */
export const PROTOCOL_MARKERS = {
  INTERRUPTED: '[koishi:interrupted]',
  SILENT: '[koishi:silent]',
  MSG_BREAK: '[koishi:msg_break]',
} as const

/** Paired open/close tags for envelope blocks. */
export const PROTOCOL_TAGS = {
  TURN_CONTEXT: { open: '<turn_context>', close: '</turn_context>' },
  USER_MESSAGE: { open: '<user_message>', close: '</user_message>' },
  INTERRUPT_NOTICE: {
    open: '<interrupt_notice>',
    close: '</interrupt_notice>',
  },
  SYSTEM_COMPACT: {
    open: '<system_compact>',
    close: '</system_compact>',
  },
} as const

/**
 * Element types that are protocol-only — must never reach the user.
 * `output-filter.ts` consumes this set to drop the elements (children
 * included) regardless of placement.
 *
 * Legacy entries (`'chat_info'`, `'system:compact'`) are kept so the
 * filter still catches accidental echoes of pre-rename tag names —
 * persisted user rows from earlier deployments still contain those
 * forms, and the agent might pattern-match and echo them. New code
 * paths only emit the current names.
 */
export const PROTOCOL_ONLY_ELEMENT_TYPES: ReadonlySet<string> = new Set([
  PROTOCOL_ELEMENT_TYPES.TURN_CONTEXT,
  'chat_info', // legacy: pre-2026-05-18 envelope tag name
  PROTOCOL_ELEMENT_TYPES.USER_MESSAGE,
  PROTOCOL_ELEMENT_TYPES.QUOTED_MESSAGE,
  PROTOCOL_ELEMENT_TYPES.INTERRUPT_NOTICE,
  PROTOCOL_ELEMENT_TYPES.SYSTEM_COMPACT,
  'system:compact', // legacy: pre-2026-05-18 namespaced form
  PROTOCOL_ELEMENT_TYPES.INTERRUPTED,
  PROTOCOL_ELEMENT_TYPES.SILENT,
  PROTOCOL_ELEMENT_TYPES.MSG_BREAK,
])
