import { Context, Logger, Schema, Session, h } from 'koishi'

import { markdownLink, markdownText } from '~/mediawiki/qq-reply'

import fexios from 'fexios'

import { type VerifySource, verifyAnswer } from './verify'

declare module 'koishi' {
  interface Tables {
    fandom_verify: FandomVerify
  }
}

/** One accepted join request. The page hash is the spent one-time code. */
export interface FandomVerify {
  hash: string
  wikiUserId: number
  wikiUserName: string
  platform: string
  selfId: string
  groupId: string
  userId: string
  time: Date
}

export interface Config {
  /** Group ids whose join requests are verified. */
  channels: string[]
  /** MediaWiki site the gadget writes to (no trailing slash). */
  wiki: string
}

export default class PluginFandomJoinVerify {
  static inject = ['database']
  static Config: Schema<Config> = Schema.object({
    channels: Schema.array(String).default([]),
    wiki: Schema.string().default('https://community.fandom.com/zh'),
  })

  private logger: Logger
  private api

  constructor(
    private ctx: Context,
    private config: Config
  ) {
    this.logger = ctx.logger('fandom-join-verify')
    this.api = fexios.create({
      baseURL: `${config.wiki}/api.php`,
      query: { format: 'json', formatversion: '2' },
    })
    ctx.model.extend(
      'fandom_verify',
      {
        hash: 'string(64)',
        wikiUserId: 'unsigned(8)',
        wikiUserName: 'string(255)',
        platform: 'string(32)',
        selfId: 'string(64)',
        groupId: 'string(128)',
        userId: 'string(128)',
        time: 'timestamp',
      },
      { primary: 'hash' }
    )

    const channels = new Set(config.channels.filter(Boolean))
    ctx.on('guild-member-request', (session) => {
      if (!channels.has(session.channelId!)) return
      void this.handle(session).catch((error) =>
        this.logger.warn('join request', error)
      )
    })
  }

  private source: VerifySource = {
    userName: async (id) => {
      const { data } = await this.api.get('', {
        query: { action: 'query', list: 'users', ususerids: String(id) },
      })
      const user = data?.query?.users?.[0]
      return user && !user.missing ? user.name : undefined
    },
    verifyPage: async (name) => {
      const { data } = await this.api.get('', {
        query: {
          action: 'query',
          prop: 'revisions',
          rvprop: 'user|content',
          rvslots: 'main',
          titles: `User:${name}/qq-hash`,
        },
      })
      const revision = data?.query?.pages?.[0]?.revisions?.[0]
      if (!revision) return
      return {
        content: revision.slots?.main?.content ?? '',
        editor: revision.user ?? '',
      }
    },
    isUsed: async (hash) =>
      !!(await this.ctx.database.get('fandom_verify', { hash }, ['hash']))
        .length,
  }

  private async handle(session: Session) {
    // qq-crack puts join_request_id in messageId; keep it before anything else.
    const requestId = session.messageId!
    const applicant = markdownText(
      session.event.user?.name || session.userId || '（未知）'
    )

    let lines: string[]
    try {
      const result = await verifyAnswer(session.content ?? '', this.source)
      if (!('reason' in result)) {
        lines = [
          `✅ 已自动同意入群：${applicant}`,
          `Fandom 账号：${this.userLink(result.wikiUserName)}`,
        ]
        try {
          await session.bot.handleGuildMemberRequest(requestId, true)
        } catch (error) {
          lines = this.pending(
            applicant,
            `验证已通过，但自动同意失败：${errorText(error)}，请手动同意`,
            result.wikiUserName
          )
          await this.notify(session, lines.join('\n\n'))
          return
        }
        // Spend the code only once the request is approved.
        await this.ctx.database
          .create('fandom_verify', {
            hash: result.hash,
            wikiUserId: result.wikiUserId,
            wikiUserName: result.wikiUserName,
            platform: session.platform,
            selfId: session.selfId,
            groupId: session.channelId!,
            userId: session.userId!,
            time: new Date(),
          })
          .catch((error) => this.logger.warn('record spent code', error))
      } else {
        lines = this.pending(applicant, result.reason, result.wikiUserName)
      }
    } catch (error) {
      lines = this.pending(applicant, `查询 Fandom 失败：${errorText(error)}`)
    }
    await this.notify(session, lines.join('\n\n'))
  }

  private pending(applicant: string, reason: string, wikiUserName?: string) {
    return [
      `⚠️ 入群申请待人工审核：${applicant}`,
      `原因：${markdownText(reason)}`,
      ...(wikiUserName
        ? [
            markdownLink(
              `核对「${wikiUserName}」的验证页`,
              this.pageUrl(`User:${wikiUserName}/qq-hash`)
            ),
          ]
        : []),
    ]
  }

  private userLink(name: string) {
    return markdownLink(name, this.pageUrl(`User:${name}`))
  }

  private pageUrl(title: string) {
    return `${this.config.wiki}/wiki/${encodeURI(title.replace(/ /g, '_'))}`
  }

  /**
   * Passive reply by event id first, proactive message otherwise. The source
   * session must not expose messageId: qq-crack would send the join request id
   * as msg_id and fail.
   */
  private async notify(session: Session, markdown: string) {
    const content = h('markdown', h.text(markdown))
    const source = Object.create(session, {
      messageId: { value: undefined },
    }) as Session
    try {
      const ids = await session.bot.sendMessage(
        session.channelId!,
        content,
        undefined,
        { session: source }
      )
      if (ids.length) return
    } catch (error) {
      this.logger.debug('passive notice failed, sending proactively', error)
    }
    await session.bot.sendMessage(session.channelId!, content)
  }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
