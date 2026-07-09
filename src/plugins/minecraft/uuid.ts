import { Context, h } from '@koishijs/core'

import BasePlugin from '../_boilerplate'

export class PluginMinecraftUuid extends BasePlugin {
  static inject = ['mojang']

  constructor(
    public ctx: Context,
    options: any
  ) {
    super(ctx, options, 'minecraft-uuid')

    ctx
      .command('minecraft.uuid [username:string]', '获取 Minecraft UUID')
      .action(async ({ session }, username) => {
        if (!username) {
          await session.send('请发送玩家名')
          username = await session.prompt(10 * 1000)
        }
        if (!username) return
        return await ctx.mojang.gerUuidByName(username).then(({ id }) => id)
      })
  }
}
