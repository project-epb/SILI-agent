/**
 * @name MgpGroupUtils
 * @desc 内部插件，萌娘百科B站粉丝群工具箱
 */
import { Context, Session, Time, h, segment } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'
import { checkUserHasRole } from '@/utils/formatSession'

interface SpamLog {
  time: string
  match: string[]
  content: string
  channelId: string
}
declare module 'koishi' {
  export interface User {
    mgpGroupSpamLogs: SpamLog[]
  }
}

export default class MoegirlGroupUtils extends BasePlugin {
  // Constants
  readonly MUTE_DURATION = [0, 10 * Time.minute, 2 * Time.hour, 1 * Time.day]
  private KEYWORDS_BLACKLIST: RegExp[] = []
  readonly COMMAND_WHITELIST = [
    'chat',
    'dialogue',
    'dice',
    'help',
    'ping',
    'pixiv',
    'profile',
    'teach',
    'wiki',
    'youdao',
  ]

  constructor(public ctx: Context) {
    super(ctx, {}, 'mgp-utils')

    this.KEYWORDS_BLACKLIST =
      process.env.MOEGIRL_KEYWORDS_BLACKLIST?.split('\n')
        .map((i) => i.trim())
        .filter((i) => !!i)
        .map((i) => new RegExp(i)) || []

    ctx.model.extend('user', {
      mgpGroupSpamLogs: 'list',
    })

    const isMoegirlChannel = (session: Session) =>
      process.env.CHANNEL_QQ_MOEGIRL_BFANS?.split('|').includes(
        session.channelId
      )

    // 指令白名单
    ctx.on('command/before-execute', async ({ command, session }) => {
      if (!isMoegirlChannel(session)) return
      const hitWhiteList = this.COMMAND_WHITELIST.some((i) =>
        command?.name?.startsWith(i)
      )
      if (hitWhiteList) return

      const isAdmin = checkUserHasRole(session, 'admin')
      if (isAdmin) return

      const { authority } = await session.getUser(session.userId, ['authority'])
      if (authority < 2) {
        this.logger.info(command!.name, '指令不在白名单，已阻断。')
        return ''
      }
    })

    // 自动禁言
    ctx.on('message', async (session) => {
      if (!isMoegirlChannel(session)) return
      if (!this.KEYWORDS_BLACKLIST.length)
        return this.logger.warn('missing KEYWORDS_BLACKLIST')

      const textSegs = segment.select(session.elements!, 'text')
      let matchedText = ''
      const hitBlackList = this.KEYWORDS_BLACKLIST.some((reg) => {
        const match = reg.exec(textSegs.join(' ') || '')
        if (match) {
          matchedText = match[0]
          return true
        }
      })
      const isAdmin = checkUserHasRole(session, 'admin')
      if (!hitBlackList || isAdmin) {
        return
      }

      let { mgpGroupSpamLogs } = await session.app.database.getUser(
        session.platform,
        session.userId as string,
        ['mgpGroupSpamLogs']
      )
      // sess.app.database.getChannel(sess.platform,sess.channelId)
      ;(mgpGroupSpamLogs = mgpGroupSpamLogs || []).push({
        time: new Date().toISOString(),
        match: [matchedText],
        content: session.content as string,
        channelId: session.channelId as string,
      })

      const count = mgpGroupSpamLogs.length
      const duration = this.MUTE_DURATION[count]
        ? this.MUTE_DURATION[count]
        : Infinity

      const log = [
        `channel: ${session.channelId} (${
          session?.event?.channel?.name || '未知群名'
        })`,
        `user: ${session.userId} (${session.username || '未知昵称'})`,
        `keywords: ${hitBlackList[1]}`,
        `${session.content}`,
        `该用户第【${count}】次触发关键词，本次将【${
          duration === Infinity ? '踢出群聊' : '禁言 ' + Time.format(duration)
        }】`,
      ].join('\n')

      // 打日志
      this.logger.info(log)

      // 禁言或踢出
      session.bot.deleteMessage(
        session.channelId as string,
        session.messageId as string
      )
      if (duration === Infinity) {
        session.bot.kickGuildMember(
          session.guildId,
          session.userId as string,
          false
        )
      } else {
        session.bot.muteGuildMember(session.channelId, session.userId, duration)
      }

      // 转发
      session.bot.sendMessage(
        process.env.CHANNEL_QQ_MOEGIRL_ADMIN_LOGS as string,
        `[MGP_UTILS] B群触发关键词黑名单${h.image(await session.app.html.text(log), 'image/jpeg')}`,
        process.env.CHANNEL_QQ_MOEGIRL_ADMIN_LOGS as string
      )

      // 行车记录仪
      session.app.database.setUser(session.platform, session.userId as string, {
        mgpGroupSpamLogs,
      })
    })

    // 入群监控
    ctx.on('guild-member-request', async (sess) => {
      if (!isMoegirlChannel(sess)) return
      const data = await sess.app.database.getUser(
        sess.platform,
        sess.userId as string,
        ['mgpGroupSpamLogs']
      )
      const logs = data?.mgpGroupSpamLogs
      if (logs && logs.length) {
        sess.bot.sendMessage(
          process.env.CHANNEL_QQ_MOEGIRL_ADMIN_LOGS as string,
          [
            `[MGP_UTILS] 请注意B群入群申请:`,
            `channel: ${sess.channelId} (${
              sess?.event?.channel?.name || '未知群名'
            })`,
            `user: ${sess.userId} (${sess.username || '未知昵称'})`,
            `该用户曾【${logs.length}】次触发关键词黑名单。`,
          ].join('\n')
        )
      }
    })
  }
}
