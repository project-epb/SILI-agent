import type { Context } from 'koishi'
import { REACTIONS } from './actions'
import type { GitHubHttp } from './http'
import type { GitHubUser } from './types'
import { describeHttpError } from './commands'

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

/** Executes a single quick-reply action against GitHub. `content` is the user's cleaned
 * reply text; `quotedText` is the original pushed message (prefix already stripped). */
export class ReplyHandler {
  constructor(
    private ctx: Context,
    private http: GitHubHttp,
    private user: GitHubUser,
    private content: string,
    private quotedText: string,
    private footer: string
  ) {}

  /** Run a network action; on failure log + return a specific hint (never throw). */
  private async run(fn: () => Promise<unknown>, hint: string): Promise<string | undefined> {
    try {
      await fn()
    } catch (e: any) {
      this.ctx.logger('github').warn(e)
      const detail = describeHttpError(e)
      return detail ? `${hint}：${detail}` : `${hint}。`
    }
  }

  link(url: string): string {
    return url
  }

  react(url: string): Promise<string | undefined> | string {
    if (!(REACTIONS as readonly string[]).includes(this.content)) {
      return `未知的 reaction，请用：${REACTIONS.join(' ')}`
    }
    return this.run(
      () => this.http.request(this.user, 'POST', url, { content: this.content }, {
        accept: 'application/vnd.github.squirrel-girl-preview',
      }),
      'reaction 失败'
    )
  }

  reply(url: string, params?: Record<string, any>): Promise<string | undefined> {
    const body = buildQuotedComment(this.quotedText, this.content, this.footer)
    return this.run(() => this.http.request(this.user, 'POST', url, { body, ...params }), '评论失败')
  }

  async close(url: string, commentUrl: string): Promise<string | undefined> {
    if (this.content) {
      const err = await this.reply(commentUrl)
      if (err) return err
    }
    return this.run(() => this.http.request(this.user, 'PATCH', url, { state: 'closed' }), '关闭失败')
  }

  base(url: string): Promise<string | undefined> {
    return this.run(() => this.http.request(this.user, 'PATCH', url, { base: this.content }), '修改 base 失败')
  }

  merge(url: string, method = 'merge'): Promise<string | undefined> {
    const [title] = this.content.split('\n', 1)
    const message = this.content.slice(title.length)
    return this.run(
      () => this.http.request(this.user, 'PUT', url, {
        merge_method: method,
        commit_title: title.trim(),
        commit_message: message.trim(),
      }),
      '合并失败'
    )
  }

  rebase(url: string): Promise<string | undefined> {
    return this.merge(url, 'rebase')
  }

  squash(url: string): Promise<string | undefined> {
    return this.merge(url, 'squash')
  }
}
