/**
 * @name ProcessErrorHandler
 * @command -
 * @internal
 * @desc 这是一个插件
 * @authority -
 */
import { Context } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

import { randomUUID } from 'crypto'

export default class ProcessErrorHandler extends BasePlugin {
  static EVENT_LIST = ['unhandledRejection', 'uncaughtException']

  constructor(public ctx: Context) {
    super(ctx, {}, 'process-error')

    ProcessErrorHandler.EVENT_LIST.forEach((i) =>
      process.on(i, (event) => this.hadnler(event))
    )
  }

  hadnler(event: any) {
    const today = new Date().toISOString().split('T')[0]
    const eventId = randomUUID()
    this.logger.error(`\n${today} ${eventId} > `, event)
    const bot = this.ctx.bots.find((i) => i.platform === 'onebot')
    bot &&
      bot.status === 1 &&
      bot
        ?.sendPrivateMessage(
          process.env.ACCOUNT_QQ_XIAOYUJUN as string,
          `[PROCESS_ERROR]\n${event.name}: ${
            event?.message || 'UNKNOWN'
          }\nEvent ID: ${today} ${eventId}`
        )
        .catch((e) => this.logger.error('Failed to send crash report', e))
  }
}
