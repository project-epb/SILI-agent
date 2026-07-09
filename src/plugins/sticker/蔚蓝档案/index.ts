/**
 * 生成蔚蓝档案LOGO风格的图片
 * @description Original work by @nulla2011 https://github.com/nulla2011/bluearchive-logo
 * @author dragon-fish (refactor)
 */
import { Context, h } from '@koishijs/core'

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { BaseSticker } from '../_base'

export default class 蔚蓝档案 extends BaseSticker {
  constructor(public ctx: Context) {
    super(ctx)

    ctx
      .command('sticker.蔚蓝档案 <text:text>', '蔚蓝档案LOGO')
      .alias('sticker.blue-archive', 'ba', '蔚蓝档案')
      .action(async (_, text) => {
        if (!text) {
          text = 'Blue Archive'
        }
        const [leftText, rightText] = this.cutTextInHalf(text)
        const image = await this.shot(leftText, rightText)
        return image
      })
  }

  async shot(leftText: string, rightText: string) {
    const url = pathToFileURL(resolve(import.meta.dirname, 'index.html'))
    url.searchParams.set('leftText', leftText)
    url.searchParams.set('rightText', rightText)

    return this.ctx.html
      .shotByUrl(url, '#logo')
      .then((buf) => {
        return h.image(buf, 'image/jpeg')
      })
      .catch((e) => {
        this.logger.error('[BA] shot error:', e)
        return `无法炼铜：${e.message || e}`
      })
  }
}
