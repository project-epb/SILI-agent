import { Context, Session, Time, h } from 'koishi'

import BasePlugin from '~/_boilerplate'

declare module 'koishi' {
  interface Tables {
    mention_logs: MentionLog
  }
}

interface MentionLog {
  id: number
  author: string
  target: string
  content: string
  messageId: string
  channelId: string
  guildId: string
  platform: string
  timestamp: number
}

export default class PluginWhoAsked extends BasePlugin {
  static inject = ['database']

  constructor(ctx: Context) {
    super(ctx, {}, 'who_asked')
    this.initDatabase()
    ctx.on('message', this.onMessage.bind(this))

    ctx
      .command('whoasked', '谁艾特我？', { minInterval: 10 * 1000 })
      .alias('谁艾特我', '谁@我', '谁at我')
      .action(async ({ session }) => {
        const dayAgo = Date.now() - 86400000
        const log = await this.findLastMention(session, dayAgo)
        if (!log) {
          return '谁问你了？'
        }
        return (
          <>
            <quote id={log.messageId} />
            请看这里，<at id={session.userId}></at>
            ！你在本频道最近一次被提及是在
            {Time.format(Date.now() - log.timestamp)}前~
            <p>
              有问题的话可以问问<at id={log.author}></at>哦~
            </p>
          </>
        )
      })

    ctx
      .command('whoasked.prune [time]', '清理过期的提及记录', {
        authority: 3,
        hidden: true,
      })
      .option('silent', '-s 静默模式')
      .action(async ({ session, options }, time) => {
        const msg = this.deleteOldLogs(time)
          .then((res) => `已清理 ${res.removed || 0} 条记录`)
          .catch((e) => '清理失败：' + e)
        return options.silent ? '' : msg
      })

    ctx.middleware(async (session, next) => {
      // Post-processing middleware: run downstream first, then maybe answer "who asked".
      // Forward the downstream result so a returned Fragment isn't swallowed.
      const result = await next()
      const keywords = ['谁艾特我', '谁@我', '谁at我']
      if (keywords.some((keyword) => session.content.endsWith(keyword))) {
        session.execute({ name: 'whoasked' })
      }
      return result
    })
  }
  private initDatabase() {
    this.ctx.model.extend(
      'mention_logs',
      {
        id: 'integer',
        author: 'string',
        target: 'string',
        content: 'string',
        messageId: 'string',
        channelId: 'string',
        guildId: 'string',
        platform: 'string',
        timestamp: 'integer',
      },
      {
        primary: 'id',
        autoInc: true,
        indexes: [
          // findLastMention
          // 包含 platform, channelId, target, timestamp，支持按时间戳排序
          ['platform', 'channelId', 'target', 'timestamp'],
          // deleteOldLogs
          ['timestamp'],
        ],
      }
    )
  }
  private deleteOldLogs(beforeTime?: Date | string | number) {
    beforeTime ||= Date.now() - 3 * 86400000
    const time = new Date(beforeTime)
    const ms = time.getTime()
    if (isNaN(ms)) {
      throw new Error('Invalid time')
    }
    if (ms > Date.now()) {
      throw new Error('Time is in the future')
    }
    return this.ctx.database.remove('mention_logs', {
      timestamp: {
        $lt: ms,
      },
    })
  }
  private onMessage(session: Session) {
    const [at] = h.select(session.elements, 'at')
    if (!at) {
      return this.logger.debug('message has not contains at')
    }
    const target = at.attrs.id || at.attrs.qq
    if (!target || target === session.bot.selfId) {
      return this.logger.debug('message missing target or target is bot itself')
    }
    this.ctx.database.create('mention_logs', {
      author: session.userId,
      target,
      content: session.content,
      messageId: session.messageId,
      channelId: session.channelId,
      guildId: session.guildId,
      platform: session.platform,
      timestamp: Date.now(),
    })
  }
  async findLastMention(session: Session, afterTime = 0) {
    return this.ctx.database
      .get(
        'mention_logs',
        {
          platform: session.platform,
          channelId: session.channelId,
          target: session.userId,
          timestamp: {
            $gt: afterTime,
          },
        },
        {
          limit: 1,
          sort: {
            timestamp: 'desc',
          },
        }
      )
      .then((logs) => logs?.[0])
  }
}
