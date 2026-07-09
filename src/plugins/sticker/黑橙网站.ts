import { Context, h } from '@koishijs/core'

import { BaseSticker } from './_base'

export default class 黑橙网站 extends BaseSticker {
  constructor(public ctx: Context) {
    super(ctx)

    ctx
      .command('sticker.pornhub <text:text>', 'PornHub')
      .alias('sticker.ph', 'ph', 'pornhub')
      .action(async (_, text) => {
        if (!text) {
          text = 'Porn Hub'
        }
        const [leftText, rightText] = this.cutTextInHalf(text)
        const image = await this.shot(leftText, rightText)
        return image
      })
  }

  toPreformattedText(text: string) {
    return text.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  async shot(leftText: string, rightText: string) {
    leftText = this.ctx.html.escapeHtmlTags(leftText)
    rightText = this.ctx.html.escapeHtmlTags(rightText)

    const html = `
<logo style="
  display: inline-flex;
  justify-content: center;
  align-items: center;
  background: #000;
  border-radius: 0.2em;
  font-size: 60px;
  padding: 0.3em;
  line-height: 1;
">
  <div style="
    color: #fff;
    padding: 0.2em;
  ">${leftText}</div>
  <div style="
    background: #ff9900;
    padding: 0.2em;
    border-radius: 0.1em;
    margin-left: 0.2em;
  ">${rightText}</div>
</logo>
`

    return this.ctx.html
      .html(html, 'logo', {
        type: 'png',
        omitBackground: true,
      })
      .then((buf) => {
        return h.image(buf, 'image/png')
      })
      .catch((e) => {
        this.logger.error('[PornHub] shot error:', e)
        return `不许色色：${e.message || e}`
      })
  }
}
