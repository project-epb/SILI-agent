import { Context, h } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

export default class PluginToImage extends BasePlugin {
  constructor(ctx: Context, options: any) {
    super(ctx, options, 'to-image')

    this.ctx = ctx.platform('onebot', 'red', 'qq')

    ctx
      .command('to-image', '搞到表情包的原图')
      .alias('toimg', '转图片', '原图')
      .action(async ({ session }) => {
        let urls: string[] = []
        if (session.quote) {
          urls = this.getImgUrlsFromMessage(session.quote.content)
        } else {
          await session.send('请发送表情包')
          const msg = await session.prompt(10 * 1000)
          urls = this.getImgUrlsFromMessage(msg)
        }
        if (!urls.length) return '没识别到……'
        this.logger.info('image urls', urls)
        return (
          <>
            {urls.map((url) => (
              <p>
                <img src={url} />
                {url}
              </p>
            ))}
          </>
        )
      })
  }

  getImgUrlsFromMessage(msg: string) {
    if (!msg) return
    const elements = h.parse(msg)
    const images = h.select(elements, 'img,face,mface')
    const urls = images
      .map((img) => img.attrs.src || img.attrs.url || '')
      .filter(Boolean)
    return urls
  }
}
