import { Context, Session } from 'koishi'

import BasePlugin from '@/plugins/_boilerplate'
import {
  type QQJoinVerificationInfo,
  joinRequestAnswerText,
} from '@/utils/qq-join-request'

export class GuildRequestFirewall extends BasePlugin {
  static readonly ANSWER_BLACK_LIST = [
    '交流学习',
    '进群交流',
    '通过一下',
    '同意一下',
    '请同意',
    '朋友推荐',
  ]

  static matches(session: Session) {
    if (session.platform !== 'qq') return false
    const raw = session.event?._data as
      | { d?: { verify_info?: QQJoinVerificationInfo } }
      | undefined
    const answer = joinRequestAnswerText(raw?.d?.verify_info ?? session.content)
    return GuildRequestFirewall.ANSWER_BLACK_LIST.some((phrase) =>
      answer.includes(phrase)
    )
  }

  constructor(ctx: Context) {
    super(ctx, null, 'guild-request-firewall')

    ctx.channel().on('guild-member-request', async (session) => {
      if (!GuildRequestFirewall.matches(session)) return
      try {
        await session.bot.handleGuildMemberRequest(session.messageId, false, '')
      } catch (error) {
        this.logger.warn('reject spam join request', error)
        return
      }
      await session.bot
        .sendMessage(session.channelId, '提示：SILI 拒绝了一条烦人的入群申请。')
        .catch((error) => this.logger.warn('notify spam rejection', error))
    })
  }
}
