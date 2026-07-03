import { Context } from 'koishi'

import BasePlugin from '~/_boilerplate'

/** `debug.reaction` — add / remove / fetch QQ NT emoji reactions on a message. */
export default class DebugReaction extends BasePlugin {
  static inject = ['qqntEmojiReaction']

  constructor(ctx: Context) {
    super(ctx, {}, 'debug-reaction')

    ctx
      .platform('onebot')
      .command('debug.reaction', 'Emoji reaction', {})
      .option('add', '-a <faceId:posint> Add reaction')
      .option('remove', '-r <faceId:posint> Remove reaction')
      .example(
        'If no action is specified, it will fetch the reactions from the message'
      )
      .action(({ session, options }) => {
        const msgId = session.quote?.id || session.messageId
        if (options.add) {
          return session
            .setReaction?.(options.add.toString())
            .then(() => '')
            .catch((e) => {
              return '失败：' + e.message
            })
        } else if (options.remove) {
          return session
            .removeReaction?.(options.remove.toString())
            .then(() => '')
            .catch((e) => {
              return '失败：' + e.message
            })
        } else {
          return this.ctx.qqntEmojiReaction
            .fetchReactions(msgId, session)
            .then((reactions) => {
              return JSON.stringify(reactions, null, 2)
            })
            .catch((e) => {
              return '失败：' + e.message
            })
        }
      })
  }
}
