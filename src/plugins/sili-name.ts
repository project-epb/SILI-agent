/**
 * @name PluginSiliName
 * @command siliname
 * @desc 让SILI修改自己的群名片
 * @authority 3
 */
import { Context } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

import { resolveBrackets } from '$utils/resolveBrackets'

export default class PluginSiliName extends BasePlugin {
  constructor(ctx: Context) {
    super(ctx, {}, 'siliName')

    ctx = ctx.channel().platform('red', 'onebot', 'qq')

    ctx
      .command('admin/siliname <name:text>', '让SILI修改自己的群名片', {
        authority: 3,
      })
      .action(async ({ session }, name) => {
        if (!name || !session) return
        if (!session.bot?.internal?.setGroupCard) {
          return '对不起，SILI目前无法修改群名片。'
        }
        try {
          await session.bot.internal.setGroupCard(
            session.channelId as string,
            session.bot.selfId,
            resolveBrackets(name)
          )
          return `明白了，请叫我“${name}”。`
        } catch (err) {
          return `哎呀，SILI在修改群名片时遇到问题：${err}`
        }
      })
  }
}
