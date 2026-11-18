/**
 * @name mute
 * @command channel.mute
 * @desc 设置群组成员禁言/全员禁言
 * @authority 3, or an admin of the group
 */
import { Context, Time } from 'koishi'

import { authorityOrGroupAdmin } from '@/modules/GroupAdminPermission'

import BasePlugin from '~/_boilerplate'

import { QQBot } from 'koishi-plugin-adapter-qq-crack'

export default class PluginMute extends BasePlugin {
  constructor(public ctx: Context) {
    super(ctx, {}, 'mute')

    ctx
      .channel()
      .command(
        'channel.mute',
        '群禁言相关 (查看子指令)',
        authorityOrGroupAdmin(3)
      )

    ctx
      .channel()
      .command('channel.mute.all', '群全员禁言', authorityOrGroupAdmin(3))
      .option('set', '-s 开启')
      .option('unset', '-u 关闭')
      .action(async ({ session, options }) => {
        if (options.set || options.unset) {
          const enable = !!options.set
          await session.bot.muteChannel(
            session.channelId,
            session.guildId,
            enable
          )
          if (session.bot instanceof QQBot) {
            // QQ can return HTTP 200 without applying the global mute rule.
            const { global_rule } =
              await session.bot.internal.getRestrictChatSetting(
                session.guildId ?? session.channelId
              )
            if (global_rule?.mode !== (enable ? 'always' : 'none')) {
              return `平台接口异常，无法确认全员禁言状态，请稍后再试`
            }
          }
          return enable ? `已开启全员禁言` : `已关闭全员禁言`
        }

        return session.execute({
          name: 'help',
          args: ['channel.mute.all'],
        })
      })

    ctx
      .channel()
      .command('channel.mute.member', '群成员禁言', authorityOrGroupAdmin(3))
      .option('user', '-u <user:user> 禁言指定用户（@提及或 @用户ID）')
      .option(
        'duration',
        '-d <duration:natural> 禁言时长，单位秒（0 为解除禁言）'
      )
      .action(async ({ session, options }) => {
        if (typeof options.duration !== 'undefined' && options.user) {
          const uid = options['user'].includes(':')
            ? options['user'].split(':')[1]
            : options['user']
          await session.bot.muteGuildMember(
            session.guildId ?? session.channelId,
            uid,
            options.duration * Time.second
          )
          return options.duration > 0
            ? `已禁言 ${options['user']} ${options.duration} 秒`
            : `已解除禁言 ${options['user']}`
        }

        return session.execute({
          name: 'help',
          args: ['channel.mute.member'],
        })
      })
  }
}
