/** Marker the old plugin appends to bot-authored bodies; everything after it is dropped. */
const INDICATOR = '<!-- BOT-MESSAGE-FOOTER -->'

/**
 * Plain-text cleanup of an issue/PR/comment body (NO markdown rendering):
 * cut at the footer indicator, strip whole-line HTML comments, trim, optionally
 * collapse blank lines, then truncate to maxLength (0 = no limit) with an ellipsis.
 *
 * `collapseBlankLines` (default true) suits the compact chat display. Pass false
 * when the result feeds a quote-reply body: blank lines are the markdown paragraph
 * separators between nested quote levels, so collapsing them jams the levels
 * together and breaks the rendered nesting.
 */
export function cleanBody(
  source: string | undefined | null,
  maxLength: number,
  collapseBlankLines = true
): string {
  if (!source) return ''
  const i = source.indexOf(INDICATOR)
  if (i >= 0) source = source.slice(0, i)
  source = source.replace(/^<!--(.*)-->$/gm, '').trim()
  if (collapseBlankLines) source = source.replace(/\n\s*\n/g, '\n')
  if (maxLength > 0 && source.length > maxLength) source = source.slice(0, maxLength) + '…'
  return source
}

/** "owner/repo#123" — used across issue/PR/comment renderers. */
export function issueName(repository: any, issue: any): string {
  return `${repository.full_name}#${issue.number}`
}
