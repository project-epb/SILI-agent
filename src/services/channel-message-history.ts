import { $, Context, Service, Session, Time, h } from 'koishi'

export interface ChannelMessage {
  platform: string
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
  /**
   * QQ official bot: the message's reference index (`REFIDX_…`). Quotes name
   * a message by it, not by its id; '' elsewhere.
   */
  refIdx: string
  time: Date
}

declare module 'koishi' {
  interface Context {
    channelMessageHistory: ChannelMessageHistory
  }

  interface Tables {
    channel_message: ChannelMessage
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
  refIdx: 'string(255)',
  time: 'timestamp',
} as const

const channelKey = ['platform', 'selfId', 'channelId'] as const
const newestFirst = { time: 'desc', messageId: 'desc' } as const

function scopeOf({ platform, selfId, channelId }: Session) {
  return { platform, selfId, channelId }
}

/**
 * A QQ official message's reference index: from the send response for the
 * bot's own messages (the adapter is patched to expose it as `_data`), from
 * `message_scene.ext` (`msg_idx=REFIDX_…`) for received ones.
 */
function refIdxOf(raw: any): string {
  const sent = raw?.ext_info?.ref_idx
  if (typeof sent === 'string') return sent
  const ext: unknown = raw?.d?.message_scene?.ext
  if (!Array.isArray(ext)) return ''
  for (const item of ext) {
    const m = /^msg_idx=(REFIDX_.+)$/.exec(String(item))
    if (m) return m[1]
  }
  return ''
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
          [...channelKey, 'refIdx'],
          ['time'],
        ],
      }
    )
    ctx.on('send', async (session) => {
      await this.record(session, true)
    })
    ctx.setInterval(() => this.cleanup(), Time.hour)
  }

  protected async start() {
    await this.cleanup()
  }

  private cutoff() {
    return new Date(Date.now() - (this.options.retentionDays ?? 30) * Time.day)
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
          refIdx: refIdxOf(raw),
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

  /**
   * A recorded message of this channel by its id, or by its QQ reference index
   * (`REFIDX_…`, what a QQ official quote carries); undefined when not recorded.
   */
  async find(session: Session, id: string): Promise<ChannelMessage | undefined> {
    const [row] = await this.ctx.database.get(
      'channel_message',
      { ...scopeOf(session), ...(id.startsWith('REFIDX_') ? { refIdx: id } : { messageId: id }) },
      { limit: 1 }
    )
    return row
  }

  /**
   * The recorded message this session quotes. A quote of one of the bot's own
   * QQ messages often carries a REFIDX other than the `ext_info.ref_idx` its
   * send returned (measured), so on a miss fall back to the quoted text among
   * the bot's own messages: exact first, then the newest one sharing its
   * opening.
   *
   * Measured, within one bot (REFIDX differs per bot, never compare across):
   * - REFIDX = 16 opaque (encrypted-looking) bytes + a per-bot suffix.
   * - The value a quote carries is stable: the same message quoted twice,
   *   26 minutes apart, gave the same REFIDX.
   * - The send-time `ext_info.ref_idx` matched for replies to a user message
   *   (LLM replies; one passive + one proactive send right after a message)
   *   and missed for GitHub pushes and for three proactive sends in a row.
   *
   * TODO(refidx): find when the send-time value is wrong. Lead: maybe only the
   * first send after a received message gets a usable one. Test one proactive
   * send with no recent message, then two in a row. If confirmed, consider
   * dropping the text fallback.
   * TODO(refidx): about 1 in 8 of the bot's own messages are recorded with
   * empty `content` (likely markdown / image sends), so a quote of one can't
   * hit the text fallback. Check this before moving pushes to markdown.
   */
  async findQuote(session: Session): Promise<ChannelMessage | undefined> {
    const quote = session.quote
    if (!quote?.id) return
    const byId = await this.find(session, quote.id)
    if (byId) return byId
    const text = quote.content?.trim()
    if (!text) return
    const own = { ...scopeOf(session), isSelf: true }
    const [exact] = await this.ctx.database.get(
      'channel_message',
      { ...own, content: text },
      { limit: 1, sort: newestFirst }
    )
    if (exact) return exact
    const head = text.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const [prefix] = await this.ctx.database.get(
      'channel_message',
      { ...own, content: { $regex: new RegExp(`^${head}`) } },
      { limit: 1, sort: newestFirst }
    )
    return prefix
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

  /**
   * How many messages others sent in this channel after `since`, the current
   * message excluded. The bot's own messages never count.
   */
  async countSince(session: Session, since: Date): Promise<number> {
    return this.ctx.database
      .select('channel_message', {
        ...scopeOf(session),
        isSelf: false,
        time: { $gt: since },
        messageId: { $ne: session.messageId },
      })
      // $.sum(1) groups to a plain counter; $.count / $.length build arrays.
      .execute(() => $.sum(1))
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
