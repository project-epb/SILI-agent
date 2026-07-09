import { Context } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

import { MinecraftSkinService } from './MinecraftSkinService'
import { MojangApiService } from './MojangApiService'
import { PluginMinecraftSkin } from './skin'
import { PluginMinecraftUuid } from './uuid'

export default class PluginMinecraft extends BasePlugin {
  constructor(
    public ctx: Context,
    options: any
  ) {
    super(ctx, options, 'minecraft')

    ctx.command('minecraft', 'Minecraft 相关功能')

    // Services
    ctx.plugin(MinecraftSkinService)
    ctx.plugin(MojangApiService)

    // Plugins
    ctx.plugin(PluginMinecraftSkin)
    ctx.plugin(PluginMinecraftUuid)
  }
}
