/**
 * IM has no stop button: a message that opens with one of these words
 * stops the running turn. Longer words come first so `停止` is not read as
 * `停` + `止`.
 */
const STOP_WORDS = ['停止', '停下', '别说了', '闭嘴', '住口', 'stop', '停']

// The word must end at a boundary, or `停车场怎么走` would stop SILI.
const STOP_PATTERN = new RegExp(
  `^\\s*(?:${STOP_WORDS.join('|')})(?=$|[\\s\\p{P}\\p{S}])[\\s\\p{P}\\p{S}]*`,
  'iu'
)

/** The text after the stop word, '' for a bare stop; null when not a stop. */
export function parseStopKeyword(text: string): string | null {
  const match = STOP_PATTERN.exec(text)
  if (!match) return null
  return text.slice(match[0].length).trim()
}
