import { Context, Time, h } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

export default class PluginWebShot extends BasePlugin {
  static inject = ['html']

  constructor(ctx: Context) {
    super(ctx, null, 'webshot')

    ctx
      .command('screenshot <url>', '截图', { authority: 2 })
      .alias('shot', '截图')
      .option('full', '-f 截取整个页面', { type: 'boolean' })
      .option('timeout', '-t <timeout> 超时时间', {
        fallback: 30 * Time.second,
      })
      .option('selector', '-s <selector> CSS选择器')
      .action(async ({ session, options }, url) => {
        return [
          h.quote(session.messageId),
          await this.handleShot(url, options),
        ]
      })
  }

  async handleShot(
    url: string,
    options: {
      full?: boolean
      timeout?: number
      selector?: string
    }
  ) {
    try {
      const urlURL = new URL(url)
      if (!urlURL.protocol.startsWith('http')) {
        return '非法的 URL'
      }
    } catch (e) {
      return '无效的 URL'
    }

    if (options.full) {
      options.selector = 'body'
    }

    try {
      const img = await this.ctx.html.shotByUrl(url, options.selector, {
        timeout: options.timeout || 30 * Time.second,
      })
      console.info('!shot', img)
      return h.image(img, 'image/jpeg')
    } catch (e) {
      return `截图时遇到问题：${e.message || e}`
    }
  }
}
