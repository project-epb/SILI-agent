import { Context, Session } from 'koishi'

import BasePlugin from '@/plugins/_boilerplate'

/**
 * If `text` opens with `name` (optionally after `@` / `＠`) followed by the same
 * separators Koishi accepts after a nickname, return what follows; otherwise
 * undefined.
 */
export function matchLeadingName(text: string, name: string) {
  if (!name) return
  let rest = text.trimStart().replace(/^[@＠]/, '')
  if (!rest.startsWith(name)) return
  rest = rest.slice(name.length)
  const sep = /^([,，]\s*|\s+|$)/.exec(rest)
  if (!sep) return
  return rest.slice(sep[0].length)
}

// `dispatch` renames the type to `message-created` before `internal/session`.
const MESSAGE_TYPES = new Set(['message', 'message-created'])

/**
 * Treat the bot's platform display name (`bot.user.name`) as a nickname, so a
 * pasted plain-text "@SILI Official /cmd" counts as calling SILI with "/cmd".
 * Without it Koishi's nickname matching eats only "SILI" and leaves
 * "Official /cmd".
 *
 * Only `session.stripped` is corrected; the message elements stay untouched.
 * Do not fake an `<at>` instead: no such mention exists on the platform, and
 * logs, LLM context and who-asked would all see it.
 *
 * Must run on `internal/session`, before anything reads `session.stripped`
 * (Koishi computes it once and caches the object, which is mutated in place).
 */
export default class PlatformNameAppel extends BasePlugin {
  constructor(public ctx: Context) {
    super(ctx, {}, 'platform-name-appel')
    ctx.on('internal/session', (session) => this.apply(session))
  }

  apply(session: Session) {
    if (!MESSAGE_TYPES.has(session.type)) return
    const name = session.bot?.user?.name
    const [first, ...others] = session.elements ?? []
    if (!name || first?.type !== 'text') return
    const rest = matchLeadingName(first.attrs.content ?? '', name)
    if (rest === undefined) return
    const stripped = session.stripped
    stripped.appel = true
    stripped.content = (rest + others.join('')).trim()
  }
}
