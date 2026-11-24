import { $, Context, Session, Time, h } from 'koishi'

import { isGroupAdmin } from '@/modules/CommandPermissions'
import { isBotMessage } from '@/utils/formatSession'

import BasePlugin from '~/_boilerplate'

interface Config {
  groupIds: string[]
  keywords: string[]
}

interface ModerationEntry {
  id: number
  selfId: string
  channelId: string
  messageId: string
  userId: string
  keyword: string
  time: Date
}

declare module 'koishi' {
  interface Tables {
    moegirl_moderation: ModerationEntry
  }
}

const LOG_GROUP = '萌娘百科官方群组群管理沟通群'
const COMMAND_WHITELIST = [
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
const MUTE_DURATIONS = [
  10 * Time.minute,
  2 * Time.hour,
  Time.day,
  30 * Time.day,
]

export default class MoegirlGroupUtils extends BasePlugin<Config> {
  static inject = ['database', 'qqbot']

  private readonly keywords: RegExp[]
  private readonly groupsByBot = new Map<string, Promise<Set<string>>>()
  private readonly pendingByUser = new Map<string, Promise<void>>()

  constructor(ctx: Context, config: Config) {
    super(ctx, config, 'mgp-utils')
    this.keywords = config.keywords.map((pattern) => new RegExp(pattern))
    ctx.model.extend(
      'moegirl_moderation',
      {
        id: 'unsigned',
        selfId: 'string(64)',
        channelId: 'string(128)',
        messageId: 'string(255)',
        userId: 'string(64)',
        keyword: 'text',
        time: 'timestamp',
      },
      {
        autoInc: true,
        unique: [['selfId', 'channelId', 'messageId']],
        indexes: [['selfId', 'userId', 'id']],
      }
    )

    ctx.before('command/execute', async ({ command, session }) => {
      if (!session || !(await this.isManagedGroup(session))) return
      if (COMMAND_WHITELIST.some((name) => command?.name.startsWith(name))) return
      if (isGroupAdmin(session)) return

      const user = await session.getUser(session.userId, ['authority'])
      if ((user?.authority ?? 0) < 2) return ''
    })

    ctx.on('message', (session) =>
      this.moderate(session).catch((error) =>
        this.logger.warn('moderation failed', error)
      )
    )
    ctx.on('guild-member-request', (session) =>
      this.checkJoinRequest(session).catch((error) =>
        this.logger.warn('join request check failed', error)
      )
    )
  }

  private async isManagedGroup(session: Session) {
    if (session.platform !== 'qq' || session.isDirect || !this.config.groupIds.length)
      return false

    const { selfId, channelId } = session
    let groups = this.groupsByBot.get(selfId)
    if (!groups) {
      groups = this.ctx.database
        .get('qqbot_migration', {
          kind: 'group',
          selfId,
          oldId: this.config.groupIds,
        }, ['newId'])
        .then((rows) => new Set([...this.config.groupIds, ...rows.map((row) => row.newId)]))
        .catch((error) => {
          this.groupsByBot.delete(selfId)
          throw error
        })
      this.groupsByBot.set(selfId, groups)
    }
    return (await groups).has(channelId)
  }

  private async moderate(session: Session) {
    if (!this.keywords.length || !(await this.isManagedGroup(session))) return
    const { selfId, userId, messageId } = session
    if (!userId || !messageId || isBotMessage(session) || isGroupAdmin(session)) return

    const text = h.select(session.elements, 'text')
      .map(({ attrs }) => attrs.content)
      .join(' ')
    const keyword = this.keywords.find((pattern) => pattern.test(text))?.exec(text)?.[0]
    if (keyword == null) return

    // Apply sanctions in order so a slower, shorter mute cannot overwrite a later one.
    const key = `${selfId}:${userId}`
    const previous = this.pendingByUser.get(key)
    const apply = async () => this.recordAndModerate(session, keyword, text)
    const next = previous ? previous.then(apply, apply) : apply()
    this.pendingByUser.set(key, next)
    try {
      await next
    } finally {
      if (this.pendingByUser.get(key) === next) this.pendingByUser.delete(key)
    }
  }

  private async recordAndModerate(session: Session, keyword: string, text: string) {
    const { selfId, userId, channelId, messageId } = session
    const db = this.ctx.database
    const key = { selfId, channelId, messageId }
    if ((await db.get('moegirl_moderation', key, ['id'])).length) return
    const { id } = await db.create('moegirl_moderation', {
      ...key,
      userId,
      keyword,
      time: new Date(),
    })
    const count = await db.select('moegirl_moderation', {
      selfId,
      userId,
      id: { $lte: id },
    }).execute(() => $.sum(1))
    const duration = MUTE_DURATIONS[Math.min(count, MUTE_DURATIONS.length) - 1]

    const [mute, recall] = await Promise.allSettled([
      session.bot.muteGuildMember(session.guildId ?? channelId, userId, duration),
      session.bot.deleteMessage(channelId, messageId),
    ])
    if (mute.status === 'rejected') this.logger.warn('mute failed', mute.reason)
    if (recall.status === 'rejected') this.logger.warn('recall failed', recall.reason)

    const action = mute.status === 'fulfilled'
      ? `已禁言 ${Time.format(duration)}`
      : `禁言失败（预定 ${Time.format(duration)}）`
    await this.notify(session, [
      '[萌百群管] 关键词命中',
      `群：${session.event.channel?.name || channelId}`,
      `用户：${session.username || userId}（${userId}）`,
      `关键词：${keyword}`,
      `第 ${count} 次触发，${action}。撤回${recall.status === 'fulfilled' ? '成功' : '失败'}。`,
      text,
    ].join('\n'))
  }

  private async checkJoinRequest(session: Session) {
    if (!(await this.isManagedGroup(session)) || !session.userId) return
    const count = await this.ctx.database.select('moegirl_moderation', {
      selfId: session.selfId,
      userId: session.userId,
    }).execute(() => $.sum(1))
    if (!count) return

    await this.notify(session, [
      '[萌百群管] 有违规记录的用户申请入群',
      `群：${session.event.channel?.name || session.channelId}`,
      `用户：${session.username || session.userId}（${session.userId}）`,
      `此前触发关键词 ${count} 次。`,
    ].join('\n'))
  }

  private async notify(session: Session, text: string) {
    this.logger.info(text)
    const channels = await this.ctx.database.get('qqbot_channel', {
      selfId: session.selfId,
      platform: 'qq',
      name: LOG_GROUP,
    }, ['id', 'removedAt', 'allowProactive', 'recvRejected'])
    const [channel, duplicate] = channels.filter((row) => !row.removedAt)
    if (!channel || duplicate || !channel.allowProactive || channel.recvRejected) {
      this.logger.warn('moderation notification destination unavailable: %s', LOG_GROUP)
      return
    }
    await session.bot.sendMessage(channel.id, h.text(text))
  }
}
