import { REACTIONS } from './actions'

/** Marker inserted between a bot-authored comment body and its footer. cleanBody
 * (events/util.ts) cuts at this marker so a rebroadcast bot comment drops the footer. */
export const INDICATOR = '<!-- BOT-MESSAGE-FOOTER -->'

/** Pure: parse a quote-reply body into an action name + message. '.' is hard-coded
 * (NOT the bot command prefix) so the reply middleware bypasses the command system. */
export function parseReplyCommand(body: string): { name: string; message: string } {
  if (/^[.!/]?help$/i.test(body)) return { name: 'help', message: '' }
  if (body.startsWith('.')) {
    const name = body.slice(1).split(/\s/, 1)[0]
    return { name, message: body.slice(1 + name.length).trim() }
  }
  const name = (REACTIONS as readonly string[]).includes(body) ? 'react' : 'reply'
  return { name, message: body }
}

const ACTION_HELP: Record<string, string> = {
  reply: '.reply <文本> — 评论（直接打字即评论）',
  react: '.react <emoji> — 加 reaction（直接发 emoji 名亦可）',
  link: '.link — 回显链接',
  close: '.close [文本] — 关闭 issue/PR（可带评论）',
  base: '.base <分支> — 改 PR base 分支',
  merge: '.merge [标题] — 合并 PR',
  rebase: '.rebase [标题] — rebase 合并 PR',
  squash: '.squash [标题] — squash 合并 PR',
}

/** Pure: build the .help reply listing the actions this message supports. */
export function formatHelp(actionNames: string[]): string {
  const lines = actionNames.filter((n) => n in ACTION_HELP).map((n) => ACTION_HELP[n])
  return ['可用快捷指令（引用本消息）：', ...lines].join('\n')
}

/** Pure: a GitHub comment body = the quoted original as a markdown blockquote,
 * then the user's reply, then INDICATOR + footer. Nested quotes accumulate because
 * existing '>' lines gain another '> '. */
export function buildQuotedComment(quotedText: string, userReply: string, footer: string): string {
  const parts: string[] = []
  const quoted = quotedText.trim()
  if (quoted) {
    parts.push(quoted.split('\n').map((line) => '> ' + line).join('\n'))
    parts.push('') // blank line between quote and reply
  }
  parts.push(userReply)
  parts.push('')
  parts.push(INDICATOR)
  if (footer) parts.push(footer)
  return parts.join('\n')
}
