import { Context } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

/** `debug.piggyback` / `debug.runas` — execute a command as another user. */
export default class DebugPiggyback extends BasePlugin {
  static inject = ['piggyback']

  constructor(ctx: Context) {
    super(ctx, {}, 'debug-piggyback')

    ctx
      .command('debug.piggyback <command:text>', 'Run as another user', {
        authority: 4,
      })
      .alias('debug.runas')
      .option('user', '-u <user:user>')
      .action(({ session, options }, command) => {
        if (!command) return session.execute('help debug.piggyback')

        const { user } = options
        if (!user) return 'No user specified.'
        const index = user.indexOf(':')
        const uin = user.slice(index + 1)
        if (uin === session.userId) {
          return 'You cannot piggyback to yourself.'
        }
        session.executeAsUser(uin, command)
      })
  }
}
