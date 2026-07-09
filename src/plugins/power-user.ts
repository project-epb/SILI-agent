import { Context } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

export default class PluginPowerUser extends BasePlugin {
  get userList() {
    return (process.env.POWERUSER_LIST || '').split('|')
  }

  constructor(ctx: Context, config: unknown) {
    super(ctx, config, 'power-user')

    ctx
      .command('admin/power <cmd:text>', 'THIS IS 抛瓦！（超级权限）', {
        authority: -1,
      })
      .alias('root', 'sudo')
      .userFields(['authority', 'id'])
      .check(({ session, options }, cmd) => {
        if (!session) return

        this.logger.info({ user: session.user, options, cmd })
        if (!this.userList.includes('' + session.user!.id)) {
          return '您没有足够的抛瓦！'
        }
      })
      .action(async ({ session, name }, cmd) => {
        if (!session) return
        if (!cmd) return session.execute({ name, options: { help: true } })

        const userLevel = session.user!.authority
        const superLevel = Date.now()
        session.user!.authority = superLevel
        await session.user?.$update()
        await session.execute(cmd)
        if (session.user!.authority === superLevel) {
          await session.user?.$update()
          session.user!.authority = userLevel
        }
      })
  }
}
