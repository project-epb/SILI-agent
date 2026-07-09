import { Context, h } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

export class PluginMinecraftSkin extends BasePlugin {
  static inject = ['mojang', 'minecraft_skin']
  static VALID_SKIN_TYPES = ['avatar', 'body', 'head', 'skins', 'capes']

  constructor(
    public ctx: Context,
    options: any
  ) {
    super(ctx, options, 'minecraft-skin')

    ctx
      .command('minecraft.skin <uuid:string>', '获取 Minecraft 皮肤')
      .option('avatar', '-A 获取头像')
      .option('body', '-B 获取全身，如果没有指定类型则默认返回这个')
      .option('head', '-H 获取头部')
      .option('skins', '-S 获取皮肤贴图')
      .option('capes', '-C 获取披风贴图')
      .action(async ({ session, options }, uuid) => {
        if (!uuid) {
          await session.send('请发送要查询的玩家名或 UUID')
          uuid = await session.prompt(10 * 1000)
          if (!uuid) return
        }
        if (!ctx.mojang.isValidUuid(uuid)) {
          uuid = await ctx.mojang.gerUuidByName(uuid).then(({ id }) => id)
        }
        if (!uuid) {
          return '未找到玩家'
        }
        let parts = Object.keys(options)
          .map((i) => i.toLowerCase())
          .filter(
            (key) =>
              options[key] && PluginMinecraftSkin.VALID_SKIN_TYPES.includes(key)
          )
        if (!parts.length) {
          parts = ['body']
        }
        return parts
          .map((key) =>
            h.image(
              ctx.minecraft_skin.assetUrl(key as any, uuid, { overlay: true })
            )
          )
          .join('\n')
      })
  }
}
