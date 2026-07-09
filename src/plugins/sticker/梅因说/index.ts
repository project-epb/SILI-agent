import { Context, Time, h } from '@koishijs/core'

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { BaseSticker } from '../_base'

/**
 * http://127.0.0.1:6780/%E6%A2%85%E5%9B%A0%E8%AF%B4/index.html?debug=true&content=%E6%A3%95%E8%89%B2%E7%8B%90%E7%8B%B8%E8%B6%8A%E8%BF%87%E4%BA%86%E9%82%A3%E5%8F%AA%E6%87%92%E7%8B%97/Quick%20brown%20fox%20jumps%20over%20the%20lazy%20dog/%E6%A3%95%E8%89%B2%E7%8B%90%E7%8B%B8%E8%B6%8A%E8%BF%87%E4%BA%86%E9%82%A3%E5%8F%AA%E6%87%92%E7%8B%97/Quick%20brown%20fox%20jumps%20over%20the%20lazy%20dog.
 */
export default class 梅因说 extends BaseSticker {
  constructor(ctx: Context) {
    super(ctx)
    ctx
      .command('sticker.梅因说 [content:text]', '沃利杰诺·梅因说', {
        minInterval: Time.minute,
      })
      .alias('sticker.main-said', '梅因说')
      .action(async ({ session }, content) => {
        if (!session) return

        content = (content || '……').slice(0, 233)
        const url = pathToFileURL(resolve(import.meta.dirname, 'index.html'))
        url.searchParams.set('content', content)

        return this.ctx.html
          .shotByUrl(url, '#memeCanvas')
          .then((buf) => {
            return h.image(buf, 'image/jpeg')
          })
          .catch((e) => {
            return `梅因嗦不粗发：${e.message || e}`
          })
      })
  }
}
