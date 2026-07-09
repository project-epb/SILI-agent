import { Context } from '@koishijs/core'

import BasePlugin from '@/plugins/_boilerplate'

export class GuildRequestFirewall extends BasePlugin {
  static readonly ANSWER_BLACK_LIST = [
    '交流学习',
    '进群交流',
    '通过一下',
    '同意一下',
    '请同意',
    '朋友推荐',
  ]

  constructor(ctx: Context) {
    super(ctx, null, 'guild-request-firewall')

    ctx.channel().on('guild-member-request', async (session) => {
      const answer = session.content.split('答案：').pop().trim()
      if (
        GuildRequestFirewall.ANSWER_BLACK_LIST.some((i) => answer.includes(i))
      ) {
        await session.bot.handleGuildMemberRequest(session.messageId, false, '')
        session.sendQueued('提示：SILI 拒绝了一条烦人的入群申请。')
      }
    })
  }
}
