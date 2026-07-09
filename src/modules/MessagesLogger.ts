/**
 * @name MessagesLogger
 * @desc 内部插件，收发消息记录日志
 */
import { Context, Session } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

import { Channel } from '@satorijs/protocol'

export default class MessagesLogger extends BasePlugin {
  constructor(public ctx: Context) {
    super(ctx, {}, 'msg')

    const UNKNOWN = '<unknown>'

    const isDirect = (session: Session) =>
      session.isDirect || session.event.channel.type === Channel.Type.DIRECT

    const channelNameCache = new Map<string, string>()
    const getChannelNameFromCache = (session: Session) => {
      return channelNameCache.get(`${session.platform}:${session.channelId}`)
    }
    const setChannelNameCache = (session: Session) => {
      const channelName = isDirect(session)
        ? session.username
        : (session.event._data?.group_name ?? session.event.channel?.name)
      if (channelName) {
        channelNameCache.set(
          `${session.platform}:${session.channelId}`,
          channelName
        )
      }
    }

    const getChannelName = (session: Session) =>
      session.event._data?.group_name ??
      session.event.channel?.name ??
      getChannelNameFromCache(session) ??
      UNKNOWN
    const formatUser = (session: Session) =>
      `${session.username} (${session.userId})`
    const formatChannel = (session: Session) =>
      `${getChannelName(session)} (${session.platform}:${session.channelId})`

    ctx.on('message', (session: Session) => {
      const content = this.toSlimContent(session.content) ?? UNKNOWN

      this.logger.info(
        '↓',
        isDirect(session)
          ? '[DM] ' + formatUser(session)
          : `${formatChannel(session)} | ${formatUser(session)}`,
        `\n${content}`
      )

      // cache channel name
      setChannelNameCache(session)
    })

    ctx.before('send', (session: Session) => {
      const content = this.toSlimContent(session.content) ?? UNKNOWN
      if (!content) return
      this.logger.info(
        '↑',
        isDirect(session)
          ? '[DM] ' + formatChannel(session)
          : formatChannel(session),
        `\n${content}`
      )
    })
  }

  /**
   * drop base64 image data
   */
  toSlimContent(content: string) {
    if (!content) return content
    return String(content).replace(
      /(src|url)="(base64:|data:)(.+?)"/gi,
      (_, $1, $2, $3) => `${$1}="${$2}(${$3.length} bytes)"`
    )
  }
}
