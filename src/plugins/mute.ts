/**
 * @name mute
 * @command channel.mute
 * @desc 设置群组成员禁言/全员禁言
 * @authority 3
 */
import { Context } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

export default class PluginMute extends BasePlugin {
  constructor(public ctx: Context) {
    super(ctx, {}, 'mute')

    ctx = ctx.platform('red', 'onebot').channel()
    ctx
      .command('channel.mute <duration:number> 群禁言，duration 为禁言时长（秒）', { authority: 3 })
      .option('set-user', '-u <user:user> 禁言指定用户')
      .option(
        'set-all',
        '-a 开关全员禁言：duration>0 开启，duration=0 关闭',
        { type: 'boolean' }
      )
      .action(({ session, options }, duration) => {
        this.logger.info(options, duration)
        if (options['set-all']) {
          if (session.platform === 'red') {
            session.bot.internal?.muteGroup({
              group: session!.channelId,
              enable: +duration > 0,
            })
          } else {
            session.bot.muteChannel(
              session.channelId,
              session.guildId,
              +duration > 0
            )
          }
        }
        if (options['set-user']) {
          const uid = options['set-user'].includes(':')
            ? options['set-user'].split(':')[1]
            : options['set-user']
          session.bot.muteGuildMember(session.channelId, uid, +duration)
        }
      })
  }
}
