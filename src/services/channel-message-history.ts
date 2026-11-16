import { Context, Service, Session, Time, h } from 'koishi'

interface LegacyMessage {
  selfId: string
  channelId: string
  messageId: string
  userId: string
  username: string
  isBot: boolean
  isSelf: boolean
  content: string
  mentions: string[]
  quoteId: string
  time: Date
}

export interface ChannelMessage extends LegacyMessage {
  platform: string
}

declare module 'koishi' {
  interface Context {
    channelMessageHistory: ChannelMessageHistory
  }

  interface Tables {
    channel_message: ChannelMessage
    qqbot_message: LegacyMessage
  }
}

interface Config {
  isServed: (session: Session, outgoing: boolean) => boolean
  retentionDays?: number
}

const messageFields = {
  selfId: 'string(64)',
  channelId: 'string(128)',
  messageId: 'string(255)',
  userId: 'string(64)',
  username: 'string(255)',
  isBot: 'boolean',
  isSelf: 'boolean',
  content: 'text',
  mentions: 'list',
  quoteId: 'string(255)',
  time: 'timestamp',
} as const

const channelKey = ['platform', 'selfId', 'channelId'] as const
const newestFirst = { time: 'desc', messageId: 'desc' } as const

function scopeOf({ platform, selfId, channelId }: Session) {
  return { platform, selfId, channelId }
}

function slimMessageContent(content: string) {
  return content.replace(
    /(src|url)="(base64:|data:)([^"]*)"/gi,
    (_, attr, scheme, data) => `${attr}="${scheme}(${data.length} bytes)"`
  )
}

function isDuplicate(error: unknown) {
  return (
    error instanceof Error &&
    (('code' in error && error.code === 'duplicate-entry') ||
      error.message === 'duplicate-entry')
  )
}

export default class ChannelMessageHistory extends Service {
  static inject = ['database']

  private log = this.ctx.logger('msg')
  private storageLog = this.ctx.logger('channel-message')

  constructor(
    ctx: Context,
    private options: Config
  ) {
    super(ctx, 'channelMessageHistory')
    ctx.model.extend(
      'channel_message',
      { platform: 'string(32)', ...messageFields },
      {
        primary: [...channelKey, 'messageId'],
        indexes: [
          [...channelKey, 'time', 'messageId'],
          [...channelKey, 'mentions', 'time'],
          ['time'],
        ],
      }
    )
    // Register the old schema so Minato can read installations that already have it.
    ctx.model.extend('qqbot_message', messageFields, {
      primary: ['selfId', 'channelId', 'messageId'],
    })
    ctx.on('send', async (session) => {
      await this.record(session, true)
    })
    ctx.setInterval(() => this.cleanup(), Time.hour)
  }

  protected async start() {
    await this.importLegacy()
    await this.cleanup()
  }

  private cutoff() {
    return new Date(Date.now() - (this.options.retentionDays ?? 30) * Time.day)
  }

  private async importLegacy() {
    const filter = { time: { $gte: this.cutoff() } }
    const limit = 250
    for (let offset = 0; ; offset += limit) {
      const rows = await this.ctx.database.get('qqbot_message', filter, {
        sort: { selfId: 'asc', channelId: 'asc', messageId: 'asc' },
        offset,
        limit,
      })
      if (!rows.length) return
      await this.ctx.database.upsert(
        'channel_message',
        rows.map((row) => ({
          ...row,
          // QQ guild channels use snowflakes, and guild DMs use a pair of them.
          platform: /^\d{1,20}(?:_\d{1,20})?$/.test(row.channelId)
            ? 'qqguild'
            : 'qq',
        }))
      )
      if (rows.length < limit) return
    }
  }

  /** Returns false when the platform already delivered this message. */
  async record(session: Session, outgoing = false): Promise<boolean> {
    if (!this.options.isServed(session, outgoing)) return true
    const { platform, selfId, channelId } = scopeOf(session)
    const messageId = session.messageId
    const userId = outgoing ? selfId : session.userId
    const username = outgoing ? session.bot.user?.name : session.username
    const elements = session.elements ?? []
    const content = session.content || elements.join('')
    if (platform && selfId && channelId && messageId) {
      const mentions = [
        ...new Set(
          h
            .select(elements, 'at')
            .map(({ attrs }) => String(attrs.id ?? attrs.qq ?? ''))
            .filter((id) => id && id !== 'all')
        ),
      ]
      const raw = session.event._data
      const author = raw?.d?.author ?? raw?.author
      try {
        await this.ctx.database.create('channel_message', {
          platform,
          selfId,
          channelId,
          messageId,
          userId: userId ?? '',
          username: username ?? '',
          isBot: outgoing || userId === selfId || !!author?.bot,
          isSelf: outgoing || userId === selfId,
          content,
          mentions,
          quoteId:
            session.event.message?.quote?.id ??
            String(h.select(elements, 'quote')[0]?.attrs.id ?? ''),
          time: new Date(session.timestamp || Date.now()),
        })
      } catch (error) {
        if (isDuplicate(error)) return false
        this.storageLog.warn('record message', error)
      }
    }
    const channel = session.event.channel?.name
    const label = `${channel ? channel + ' ' : ''}(${platform}:${channelId})`
    const sender = outgoing ? '' : ` | ${username || '<unknown>'} (${userId})`
    this.log.info(
      outgoing ? '↑' : '↓',
      `${session.isDirect ? '[DM] ' : ''}${label}${sender}\n${slimMessageContent(content) || '<empty>'}`
    )
    return true
  }

  /** Oldest first. An explicit cursor includes its message. */
  async read(session: Session, count: number, beforeMessageId?: string) {
    if (!this.options.isServed(session, false))
      throw new Error('Channel is not served')
    const scope = scopeOf(session)
    const id = beforeMessageId || session.messageId
    const [anchor] = id
      ? await this.ctx.database.get(
          'channel_message',
          { ...scope, messageId: id },
          ['time', 'messageId']
        )
      : []
    if (beforeMessageId && !anchor)
      throw new Error('指定的消息不在当前频道记录中。')

    const rows = await this.ctx.database.get(
      'channel_message',
      {
        ...scope,
        ...(anchor
          ? {
              $or: [
                { time: { $lt: anchor.time } },
                { time: anchor.time, messageId: { $lte: anchor.messageId } },
              ],
            }
          : { time: { $lte: new Date(session.timestamp || Date.now()) } }),
      },
      { limit: count + 1, sort: newestFirst }
    )
    const nextMessageId = rows[count]?.messageId
    return { messages: rows.slice(0, count).reverse(), nextMessageId }
  }

  async lastMention(session: Session, since: Date) {
    if (!session.userId || !this.options.isServed(session, false)) return
    const [row] = await this.ctx.database.get(
      'channel_message',
      {
        ...scopeOf(session),
        isSelf: false,
        mentions: { $el: { $eq: session.userId } },
        time: { $gt: since },
      },
      { limit: 1, sort: newestFirst }
    )
    return row
  }

  private async cleanup() {
    try {
      await this.ctx.database.remove('channel_message', {
        time: { $lt: this.cutoff() },
      })
    } catch (error) {
      this.storageLog.warn('cleanup', error)
    }
  }
}
