import { Context, Service, Session } from 'koishi'

declare module 'koishi' {
  interface Session {
    setReaction(emojiId: string): Promise<string>
    removeReaction(emojiId: string): Promise<string>
  }
  interface Context {
    qqntEmojiReaction: QQNTEmojiReactionService
  }
}

export class QQNTEmojiReactionService extends Service {
  constructor(public ctx: Context) {
    super(ctx)
    this.ctx.set('qqntEmojiReaction', this)

    const that = this
    this.ctx
      .platform('onebot')
      .set('session.setReaction', function (this: Session, emojiId: string) {
        return that.setReaction(this, emojiId)
      })
    this.ctx
      .platform('onebot')
      .set('session.removeReaction', function (this: Session, emojiId: string) {
        return that.removeReaction(this, emojiId)
      })
  }

  private isOnebotSession(session: Session) {
    return session.platform === 'onebot'
  }

  public async setReaction(session: Session, emojiId: string) {
    if (!this.isOnebotSession(session)) {
      throw new Error('Unsupported platform.')
    }
    const numricEmojiId = parseInt(emojiId, 10)
    const message_id = session.quote?.id || session.messageId
    if (isNaN(numricEmojiId) || numricEmojiId < 1) return 'Invalid face ID.'
    return session.onebot?._request('set_msg_emoji_like', {
      message_id,
      emoji_id: numricEmojiId.toString(),
    })
  }

  public async removeReaction(session: Session, emojiId: string) {
    if (!this.isOnebotSession(session)) {
      throw new Error('Unsupported platform.')
    }
    const numricEmojiId = parseInt(emojiId, 10)
    const message_id = session.quote?.id || session.messageId
    if (isNaN(numricEmojiId) || numricEmojiId < 1) return 'Invalid face ID.'
    return session.onebot?._request('delete_msg_emoji_like', {
      message_id,
      emoji_id: numricEmojiId.toString(),
    })
  }

  public async fetchReactions(messageId: string, session?: Session) {
    const bot =
      session?.onebot ||
      (this.ctx.bots.find(
        (bot) => bot.platform === 'onebot'
      ) as unknown as Session['onebot'])
    if (!bot) {
      throw new Error('No bot found.')
    }
    return bot._request('fetch_emoji_like', {
      message_id: messageId,
    })
  }
}
