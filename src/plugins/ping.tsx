/**
 * @name ping-pong
 * @command ping
 * @desc 应答测试
 * @authority 1
 */
import { Context, Random, Time } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

export default class PluginPing extends BasePlugin {
  constructor(public ctx: Context) {
    super(ctx, {}, 'ping')

    ctx
      .command('ping', '应答测试', { minInterval: 10 * Time.second })
      .alias('在吗', '!', '！')
      .action(({ session }) => {
        this.logger.info(new Date().toISOString())
        this.logger.info(session)
        return Random.pick([
          '？',
          '嗯？',
          '咋了？',
          'pong~',
          '诶，我在~',
          '叫我干嘛呀~',
          'Link start~',
          '你说，我在听',
          'Aye Aye Captain~',
          "I'm still alive~",
          '我会稳~稳~地~接住你！',
        ])
      })
  }
}
