import type { Context, Session } from 'koishi'

import {
  GUARDED_PLATFORMS,
  type ServedLookup,
  type SessionFacts,
  isServed,
} from './gate'

export function factsOf(session: Session): SessionFacts {
  return {
    platform: session.platform,
    isDirect: !!session.isDirect,
    selfId: session.selfId ?? '',
    channelId: session.channelId ?? '',
    userId: session.userId ?? '',
  }
}

/**
 * In-memory served state. Every decision on the hot path (gate, served ctx
 * filter, autoAuthorize) must be synchronous, so this mirrors the database:
 * loaded on start, reloaded periodically, and updated in place by whoever
 * changes activation (assign, admin page, group migration).
 */
export class ServedState implements ServedLookup {
  private activeGroups = new Set<string>()
  private dmActive = new Set<string>()
  private ops = new Set<string>()

  private static groupKey(platform: string, selfId: string, channelId: string) {
    return `${platform}:${selfId}:${channelId}`
  }
  private static userKey(platform: string, selfId: string, userId: string) {
    return `${platform}:${selfId}:${userId}`
  }

  isGroupActive(platform: string, selfId: string, channelId: string) {
    return this.activeGroups.has(ServedState.groupKey(platform, selfId, channelId))
  }

  isDmAllowed(platform: string, selfId: string, userId: string) {
    return (
      this.isOp(platform, userId) ||
      this.dmActive.has(ServedState.userKey(platform, selfId, userId))
    )
  }

  isOp(platform: string, userId: string) {
    return this.ops.has(`${platform}:${userId}`)
  }

  isServedSession(session: Session) {
    return isServed(factsOf(session), this)
  }

  setGroupActive(platform: string, selfId: string, channelId: string, active: boolean) {
    const key = ServedState.groupKey(platform, selfId, channelId)
    if (active) this.activeGroups.add(key)
    else this.activeGroups.delete(key)
  }

  setDmActive(platform: string, selfId: string, userId: string, active: boolean) {
    const key = ServedState.userKey(platform, selfId, userId)
    if (active) this.dmActive.add(key)
    else this.dmActive.delete(key)
  }

  async reload(ctx: Context) {
    const platforms = [...GUARDED_PLATFORMS]
    const channels = await ctx.database.get('channel', { platform: platforms }, [
      'id',
      'platform',
      'assignee',
    ])
    const activeGroups = new Set<string>()
    for (const { id, platform, assignee } of channels) {
      if (assignee) activeGroups.add(ServedState.groupKey(platform, assignee, id))
    }

    const dmRows = await ctx.database.get('qqbot_user', { dmActive: true }, [
      'selfId',
      'id',
      'platform',
    ])
    const dmActive = new Set(
      dmRows.map((u) => ServedState.userKey(u.platform, u.selfId, u.id))
    )

    const opUsers = await ctx.database.get('user', { authority: { $gte: 4 } }, ['id'])
    const ops = new Set<string>()
    if (opUsers.length) {
      const bindings = await ctx.database.get(
        'binding',
        { aid: opUsers.map((u) => u.id), platform: platforms },
        ['pid', 'platform']
      )
      for (const { pid, platform } of bindings) ops.add(`${platform}:${pid}`)
    }

    this.activeGroups = activeGroups
    this.dmActive = dmActive
    this.ops = ops
  }
}
