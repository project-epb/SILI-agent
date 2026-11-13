import { type Session, h } from 'koishi'

const MAX_MARKDOWN_LENGTH = 800

export function markdownText(text: string) {
  return text.replace(/\s+/g, ' ').replace(/[!-\/:-@\[-`{-~]/g, '\\$&')
}

export function markdownLink(label: string, url: string) {
  try {
    const target = new URL(url)
    if (target.protocol === 'https:' || target.protocol === 'http:') {
      const href = target.href.replace(/[()]/g, (char) =>
        char === '(' ? '%28' : '%29'
      )
      return `[${markdownText(label)}](${href})`
    }
  } catch {
    // A malformed URL can still have a displayable label.
  }
  return markdownText(label)
}

export function qqWikiReply(session: Session, entries: string[], header = '') {
  const parts = header ? [header] : []
  for (const [index, entry] of entries.entries()) {
    const remaining = entries.length - index - 1
    const suffix = remaining ? `\n\n另有 ${remaining} 条未显示` : ''
    if (
      [...parts, entry].join('\n\n').length + suffix.length >
      MAX_MARKDOWN_LENGTH
    ) {
      parts.push(`另有 ${remaining + 1} 条未显示`)
      break
    }
    parts.push(entry)
  }
  return [
    ...(session.messageId ? [h.quote(session.messageId)] : []),
    h('markdown', h.text(parts.join('\n\n'))),
  ]
}
