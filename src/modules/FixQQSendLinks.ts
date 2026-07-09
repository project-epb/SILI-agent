import { Context } from '@koishijs/core'

import BasePlugin from '@/plugins/_boilerplate'

/**
 * FIXME: 这是针对 QQ 无法发送链接的临时修复：我们给所有的链接都添加一个前置标点符号以绕过此过滤器
 */
export class FixQQSendLinks extends BasePlugin {
  constructor(public ctx: Context) {
    super(ctx, {}, 'fix-qq-send-links')

    ctx.platform('onebot').before('send', (session) => {
      for (const el of session.elements.flat(Infinity) || []) {
        if (el.type === 'text' && el.attrs.content) {
          el.attrs.content = el.attrs.content.replace(
            /(https?:\/\/[^\s]+)/g,
            '#$1' // 使用全角字符代替半角字符
          )
        }
      }
    })
  }
}
