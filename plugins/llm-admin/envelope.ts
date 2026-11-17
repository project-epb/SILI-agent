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
