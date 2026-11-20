import { Context, Session } from 'koishi'

import BasePlugin from '@/plugins/_boilerplate'

/**
 * If `text` opens with a plain-text `@` / `＠`, return what follows the `@`;
 * otherwise undefined.
 */
export function afterPlainAt(text: string) {
  const trimmed = text.trimStart()
  if (!/^[@＠]/.test(trimmed)) return
  return trimmed.slice(1)
}

/**
 * If `text` (the part after a plain `@`) opens with `name` followed by the
 * separators Koishi accepts after a nickname, return what follows; otherwise
 * undefined.
 */
export function matchName(text: string, name: string) {
  if (!name || !text.startsWith(name)) return
  const rest = text.slice(name.length)
  const sep = /^([,，]\s*|\s+|$)/.exec(rest)
  if (!sep) return
  return rest.slice(sep[0].length)
}

// `dispatch` renames the type to `message-created` before `internal/session`.
const MESSAGE_TYPES = new Set(['message', 'message-created'])

/**
 * A message opening with a plain-text `@` (a pasted mention) calls this bot
 * only when what follows is the bot's platform display name (`bot.user.name`),
 * which is what a pasted mention always carries. Configured nicknames never
 * match it.
 *
 * Koishi's own nickname matching drops the leading `@` and compares configured
 * nicknames, so "@SILI Noir /usage" calls every bot nicknamed "SILI", and
 * "@SILI Official /usage" leaves "Official /usage". This corrects
 * `session.stripped` (computed once and cached; the object is mutated in place)
 * and leaves the message elements untouched. Do not fake an `<at>` instead: no
 * such mention exists on the platform, and logs, LLM context and who-asked
 * would all see one.
 *
 * Must run on `internal/session`, before anything reads `session.stripped`.
 */
export default class PlainTextAt extends BasePlugin {
  constructor(public ctx: Context) {
    super(ctx, {}, 'plain-text-at')
    ctx.on('internal/session', (session) => this.apply(session))
  }

  apply(session: Session) {
    if (!MESSAGE_TYPES.has(session.type)) return
    const elements = (session.elements ?? []).slice()
    // Skip leading mentions the way Koishi does: a quote reply opens with a
    // real <at> of the quoted author, which Koishi does not count as `hasAt`.
    while (elements[0]?.type === 'at') {
      elements.shift()
      const next = elements[0]
      if (next?.type === 'text' && !next.attrs.content?.trim()) elements.shift()
    }
    const body = elements.join('').trim()
    const afterAt = afterPlainAt(body)
    if (afterAt === undefined) return
    const stripped = session.stripped
    if (stripped.hasAt || stripped.atSelf) return
    const rest = matchName(afterAt, session.bot?.user?.name ?? '')
    if (rest !== undefined) {
      stripped.appel = true
      stripped.content = rest.trim()
    } else if (stripped.appel) {
      stripped.appel = false
      stripped.content = body
    }
  }
}
