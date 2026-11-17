export interface EnvelopeMessage {
  /** How the speaker is addressed: callme > group card > platform name. */
  speaker: string
  text: string
}

const PAIR =
  /<turn_context>\s*([\s\S]*?)\s*<\/turn_context>[\s\S]*?<user_message>([\s\S]*?)<\/user_message>/g

function speakerOf(turnContext: string): string {
  try {
    const ctx = JSON.parse(turnContext)
    return (
      ctx?.koishi?.callme ||
      ctx?.platform?.user?.group_nickname ||
      ctx?.platform?.user?.name ||
      ''
    )
  } catch {
    return ''
  }
}

/**
 * The messages inside a persisted user row. A row normally holds one
 * envelope; a group turn can open with several (messages steered too late
 * into the previous turn). Rows from before envelopes were persisted are
 * returned whole, without a speaker.
 */
export function parseEnvelopes(content: string): EnvelopeMessage[] {
  const found = [...content.matchAll(PAIR)].map((m) => ({
    speaker: speakerOf(m[1]),
    text: m[2].trim(),
  }))
  return found.length ? found : [{ speaker: '', text: content.trim() }]
}

const STEER_OPEN = '<steer_notice>'

/**
 * A tool result can carry messages steered in while SILI was working (see
 * the llm plugin's steer): the tool output, then a `<steer_notice>` block,
 * then each message's envelope. Split them so the steered messages can be
 * shown as chat messages of their own.
 */
export function splitSteer(content: string): {
  tool: string
  steered: EnvelopeMessage[]
} {
  const at = content.indexOf(STEER_OPEN)
  if (at < 0) return { tool: content, steered: [] }
  const found = [...content.slice(at).matchAll(PAIR)].map((m) => ({
    speaker: speakerOf(m[1]),
    text: m[2].trim(),
  }))
  return { tool: content.slice(0, at).trimEnd(), steered: found }
}
