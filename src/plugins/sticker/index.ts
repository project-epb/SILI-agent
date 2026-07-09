/**
 * @name PluginSticker
 * @command sticker
 * @desc 生成表情包
 * @authority 1
 */
import { Context } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

import 加油 from './加油'
import 喜报悲报 from './喜报悲报'
import 梅因说 from './梅因说'
import 状态码猫猫 from './状态码猫猫'
import 蔚蓝档案 from './蔚蓝档案'
import 黑橙网站 from './黑橙网站'

export default class PluginSticker extends BasePlugin {
  constructor(ctx: Context) {
    super(ctx, {}, 'sticker')
    ctx.command('sticker', '生成表情包！').alias('表情包')
    // all stickers
    ctx.plugin(加油)
    ctx.plugin(梅因说)
    ctx.plugin(蔚蓝档案)
    ctx.plugin(黑橙网站)
    ctx.plugin(喜报悲报)
    ctx.plugin(状态码猫猫)
  }
}
