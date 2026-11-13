import { Context, Logger, Session, Time, h } from 'koishi'

import { GUARDED_PLATFORMS } from './gate'
import type { ServedState } from './state'
import type { QQBotMessage } from './tables'

/** minato's mongo driver throws RuntimeError('duplicate-entry') on E11000. */
function isDuplicate(error: unknown) {
  return (
    !!error &&
    typeof error === 'object' &&
    ((error as any).code === 'duplicate-entry' ||
      (error as Error).message === 'duplicate-entry')
  )
}

function rawAuthor(session: Session): any {
  const data: any = session.event?._data
  return data?.d?.author ?? data?.author
}

/**
 * Message store for served qq channels. Its primary key doubles as the dedupe
 * gate: the platform re-pushes the same message, and a duplicate insert means
 * "already handled", so the caller stops processing it.
 */
export class MessageStore {
  private logger: Logger

  constructor(
    private ctx: Context,
    private state: ServedState,
    private retentionDays: number
  ) {
    this.logger = ctx.logger('qqbot-store')
    ctx.on('ready', () => this.cleanup())
    ctx.setInterval(() => this.cleanup(), Time.hour)
    // The platform never pushes the bot's own messages back, so record sends.
    ctx.on('send', (session) => {
      if (!GUARDED_PLATFORMS.has(session.platform) || !session.messageId) return
      // Send sessions carry no userId; a DM's peer is encoded in the channel id.
      const { platform, selfId, channelId } = session
      const served = session.isDirect
        ? this.state.isDmAllowed(
            platform,
            selfId,
            channelId.replace(/^private:/, '')
          )
        : this.state.isGroupActive(platform, selfId, channelId)
      if (!served) return
      this.ctx.database
        .create('qqbot_message', this.rowOf(session, true))
        .catch((error) => {
          if (!isDuplicate(error))
            this.logger.warn('record sent message', error)
        })
    })
  }

  /** Insert an incoming message. Returns false when it is a duplicate push. */
  async insert(session: Session): Promise<boolean> {
    if (!session.messageId) return true
    try {
      await this.ctx.database.create(
        'qqbot_message',
        this.rowOf(session, false)
      )
      return true
    } catch (error) {
      if (isDuplicate(error)) return false
      // Storage trouble must not take message handling down with it.
      this.logger.warn('store message', error)
      return true
    }
  }

  private rowOf(session: Session, isSelf: boolean): QQBotMessage {
    const elements = session.elements ?? []
    const mentions = h
      .select(elements, 'at')
      .map((el) => String(el.attrs.id ?? ''))
      .filter(Boolean)
    const quote = session.event?.message?.quote
    return {
      selfId: session.selfId,
      channelId: session.channelId,
      messageId: session.messageId,
      userId: isSelf ? session.selfId : (session.userId ?? ''),
      username: isSelf
        ? (session.bot.user?.name ?? '')
        : (session.username ?? ''),
      isBot: isSelf || !!rawAuthor(session)?.bot,
      isSelf,
      content: session.content ?? '',
      mentions,
      quoteId: quote?.id ?? '',
      time: new Date(session.timestamp || Date.now()),
    }
  }

  private async cleanup() {
    const cutoff = new Date(Date.now() - this.retentionDays * Time.day)
    try {
      await this.ctx.database.remove('qqbot_message', { time: { $lt: cutoff } })
    } catch (error) {
      this.logger.warn('cleanup', error)
    }
  }
}
