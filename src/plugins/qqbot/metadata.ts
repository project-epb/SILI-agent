import { Bot, Context, Logger, Session, Time } from 'koishi'

import { GUARDED_PLATFORMS } from './gate'
import type { ServedState } from './state'

interface ChannelDelta {
  selfId: string
  id: string
  platform: string
  firstSeen: Date
  lastSeen: Date
  count: number
}
interface UserDelta {
  selfId: string
  id: string
  platform: string
  name?: string
  firstSeen: Date
  lastSeen: Date
  count: number
  dmCount: number
}
interface MemberDelta {
  selfId: string
  channelId: string
  userId: string
  firstSeen: Date
  lastSeen: Date
  count: number
}

/** Official group info APIs allow 30 calls/minute; keep well under it. */
const REFRESH_SPACING_MS = 2500

/**
 * Records who and where the bot has seen, for every qq message (served or
 * not), without content. Counts accumulate in memory and are merged into the
 * tables about once a minute. Each flush only writes the fields it owns, so it
 * never clobbers names or bot state written by a group-info refresh.
 */
export class MetadataRecorder {
  private logger: Logger
  private channels = new Map<string, ChannelDelta>()
  private users = new Map<string, UserDelta>()
  private members = new Map<string, MemberDelta>()
  /** Groups known to exist in qqbot_channel; first sight triggers an info refresh. */
  private knownGroups = new Set<string>()
  private refreshQueue: Array<[string, string]> = []
  private refreshing = false

  constructor(
    private ctx: Context,
    private state: ServedState
  ) {
    this.logger = ctx.logger('qqbot-meta')
    ctx.on('ready', async () => {
      try {
        const rows = await ctx.database.get('qqbot_channel', {}, ['selfId', 'id'])
        for (const row of rows) this.knownGroups.add(`${row.selfId}:${row.id}`)
      } catch (error) {
        this.logger.warn('load known groups', error)
      }
    })
    ctx.setInterval(() => this.flush(), Time.minute)
    ctx.on('dispose', () => this.flush())

    ctx.on('guild-added', (session) => this.onGuildAdded(session))
    ctx.on('guild-removed', (session) => this.onGuildRemoved(session))
    // qq-crack emits these non-standard event names.
    ctx.on('group-msg-reject' as any, (session: Session) => this.setRejected(session, true))
    ctx.on('group-msg-receive' as any, (session: Session) => this.setRejected(session, false))
  }

  record(session: Session) {
    if (!GUARDED_PLATFORMS.has(session.platform)) return
    const { platform, selfId, userId, channelId } = session
    const now = new Date(session.timestamp || Date.now())
    if (userId) {
      const key = `${selfId}:${userId}`
      const user = this.users.get(key) ?? {
        selfId,
        id: userId,
        platform,
        firstSeen: now,
        lastSeen: now,
        count: 0,
        dmCount: 0,
      }
      user.lastSeen = now
      user.count++
      if (session.isDirect) user.dmCount++
      if (session.username) user.name = session.username
      this.users.set(key, user)
    }
    if (session.isDirect || !channelId) return

    const groupKey = `${selfId}:${channelId}`
    const channel = this.channels.get(groupKey) ?? {
      selfId,
      id: channelId,
      platform,
      firstSeen: now,
      lastSeen: now,
      count: 0,
    }
    channel.lastSeen = now
    channel.count++
    this.channels.set(groupKey, channel)
    if (!this.knownGroups.has(groupKey)) {
      this.knownGroups.add(groupKey)
      this.queueRefresh(selfId, channelId)
    }

    if (userId) {
      const memberKey = `${selfId}:${channelId}:${userId}`
      const member = this.members.get(memberKey) ?? {
        selfId,
        channelId,
        userId,
        firstSeen: now,
        lastSeen: now,
        count: 0,
      }
      member.lastSeen = now
      member.count++
      this.members.set(memberKey, member)
    }
  }

  async flush() {
    const channels = [...this.channels.values()]
    const users = [...this.users.values()]
    const members = [...this.members.values()]
    this.channels.clear()
    this.users.clear()
    this.members.clear()
    try {
      if (channels.length) {
        const existing = await this.ctx.database.get('qqbot_channel', {
          $or: channels.map(({ selfId, id }) => ({ selfId, id })),
        })
        const byKey = new Map(existing.map((r) => [`${r.selfId}:${r.id}`, r]))
        await this.ctx.database.upsert(
          'qqbot_channel',
          channels.map((d) => {
            const row = byKey.get(`${d.selfId}:${d.id}`)
            return {
              selfId: d.selfId,
              id: d.id,
              platform: d.platform,
              firstSeen: row?.firstSeen ?? d.firstSeen,
              lastSeen: d.lastSeen,
              messageCount: (row?.messageCount ?? 0) + d.count,
            }
          })
        )
      }
      if (users.length) {
        const existing = await this.ctx.database.get('qqbot_user', {
          $or: users.map(({ selfId, id }) => ({ selfId, id })),
        })
        const byKey = new Map(existing.map((r) => [`${r.selfId}:${r.id}`, r]))
        await this.ctx.database.upsert(
          'qqbot_user',
          users.map((d) => {
            const row = byKey.get(`${d.selfId}:${d.id}`)
            return {
              selfId: d.selfId,
              id: d.id,
              platform: d.platform,
              ...(d.name ? { name: d.name } : {}),
              firstSeen: row?.firstSeen ?? d.firstSeen,
              lastSeen: d.lastSeen,
              messageCount: (row?.messageCount ?? 0) + d.count,
              dmCount: (row?.dmCount ?? 0) + d.dmCount,
            }
          })
        )
      }
      if (members.length) {
        const existing = await this.ctx.database.get('qqbot_member', {
          $or: members.map(({ selfId, channelId, userId }) => ({ selfId, channelId, userId })),
        })
        const byKey = new Map(
          existing.map((r) => [`${r.selfId}:${r.channelId}:${r.userId}`, r])
        )
        await this.ctx.database.upsert(
          'qqbot_member',
          members.map((d) => {
            const row = byKey.get(`${d.selfId}:${d.channelId}:${d.userId}`)
            return {
              selfId: d.selfId,
              channelId: d.channelId,
              userId: d.userId,
              firstSeen: row?.firstSeen ?? d.firstSeen,
              lastSeen: d.lastSeen,
              messageCount: (row?.messageCount ?? 0) + d.count,
            }
          })
        )
      }
    } catch (error) {
      this.logger.warn('flush', error)
    }
  }

  private async onGuildAdded(session: Session) {
    if (!GUARDED_PLATFORMS.has(session.platform) || !session.guildId) return
    const { selfId, guildId, platform } = session
    try {
      const [row] = await this.ctx.database.get('qqbot_channel', { selfId, id: guildId })
      await this.ctx.database.upsert('qqbot_channel', [
        {
          selfId,
          id: guildId,
          platform,
          addedBy: session.operatorId ?? '',
          firstSeen: row?.firstSeen ?? new Date(),
          removedAt: null,
        },
      ])
      this.knownGroups.add(`${selfId}:${guildId}`)
      this.queueRefresh(selfId, guildId)
    } catch (error) {
      this.logger.warn('guild-added', error)
    }
  }

  /**
   * The bot was removed: forget the activation too, so that whoever adds it
   * back later does not inherit a served group.
   */
  private async onGuildRemoved(session: Session) {
    if (!GUARDED_PLATFORMS.has(session.platform) || !session.guildId) return
    const { selfId, guildId, platform } = session
    try {
      await this.ctx.database.upsert('qqbot_channel', [
        { selfId, id: guildId, platform, removedAt: new Date() },
      ])
      await this.ctx.database.set(
        'channel',
        { platform, id: guildId, assignee: selfId },
        { assignee: '' }
      )
      this.state.setGroupActive(platform, selfId, guildId, false)
    } catch (error) {
      this.logger.warn('guild-removed', error)
    }
  }

  private async setRejected(session: Session, rejected: boolean) {
    const id = session.guildId ?? session.channelId
    if (!GUARDED_PLATFORMS.has(session.platform) || !id) return
    try {
      await this.ctx.database.upsert('qqbot_channel', [
        { selfId: session.selfId, id, platform: session.platform, recvRejected: rejected },
      ])
    } catch (error) {
      this.logger.warn('group-msg-reject/receive', error)
    }
  }

  queueRefresh(selfId: string, groupId: string) {
    this.refreshQueue.push([selfId, groupId])
    if (!this.refreshing) void this.drainRefreshQueue()
  }

  private async drainRefreshQueue() {
    this.refreshing = true
    try {
      while (this.refreshQueue.length) {
        const [selfId, groupId] = this.refreshQueue.shift()!
        await this.refreshGroup(selfId, groupId)
        await new Promise((resolve) => setTimeout(resolve, REFRESH_SPACING_MS))
      }
    } finally {
      this.refreshing = false
    }
  }

  /** Pull group name / member count and the bot's state in the group. */
  async refreshGroup(selfId: string, groupId: string) {
    const bot = this.ctx.bots.find(
      (b: Bot) => b.platform === 'qq' && b.selfId === selfId
    ) as any
    if (!bot?.internal) return
    const patch: Record<string, unknown> = {
      selfId,
      id: groupId,
      platform: 'qq',
      infoUpdatedAt: new Date(),
    }
    try {
      const info = await bot.internal.getGroupInfo(groupId)
      patch.name = info?.group_name ?? ''
      patch.memberNum = info?.group_member_num ?? 0
    } catch (error) {
      this.logger.debug('getGroupInfo %s failed: %s', groupId, (error as Error)?.message)
    }
    try {
      const state = await bot.internal.getBotGroupState(groupId)
      patch.role = state?.member_role ?? ''
      patch.recvSetting = state?.recv_msg_setting ?? ''
      patch.allowProactive = !!state?.allow_proactive_msg
    } catch (error) {
      this.logger.debug('getBotGroupState %s failed: %s', groupId, (error as Error)?.message)
    }
    try {
      await this.ctx.database.upsert('qqbot_channel', [patch as any])
    } catch (error) {
      this.logger.warn('save group info', error)
    }
  }
}
