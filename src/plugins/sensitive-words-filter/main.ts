import { Context, Session, h } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

export default class SensitiveFilterMain extends BasePlugin {
  static inject = ['mint']

  constructor(public ctx: Context) {
    super(ctx, {}, 'sensitive-filter')
    ctx.before('send', this.onBeforeSend.bind(this))
  }

  onBeforeSend(session: Session) {
    if (!session.elements) return
    const textSegs = h.select(session.elements, 'text')
    const pass = this.ctx.mint.verify(textSegs.join(' '))
    if (!pass) {
      const original = session.content
      session.elements.forEach((i, index) => {
        if (i.type === 'text') {
          session.elements![index].attrs.content =
            this.ctx.mint.filter(i?.attrs?.content || '').text?.toString() || ''
        }
      })
      this.logger.info('send-has-sensitive', {
        before: original,
        after: session.content,
      })
    }
  }
}
