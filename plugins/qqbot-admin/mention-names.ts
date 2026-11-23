import { $, Context, Time } from 'koishi'

import { GUARDED_PLATFORMS } from '../../src/plugins/qqbot/gate'
import type { ChannelMessage } from '../../src/services/channel-message-history'

type Scope = Pick<ChannelMessage, 'platform' | 'selfId' | 'channelId'>
type Speaker = Pick<ChannelMessage, 'userId' | 'username'>
const CACHE_TTL = Time.minute
const CACHE_SIZE = 2048

export function knownName(value: unknown, id: string) {
  if (typeof value !== 'string') return
  const name = value.trim()
  return name && name !== id ? name : undefined
}

export function createMentionNameLookup(ctx: Context) {
  const cache = new Map<string, { name?: string; expires: number }>()

  return async function lookup(
    scope: Scope,
    ids: ReadonlySet<string>,
    page: readonly Speaker[]
  ) {
    const names = new Map<string, string>()
    if (!ids.size) return names
    const seenHere = new Map<string, string>()
    const hasQqDirectory = GUARDED_PLATFORMS.has(scope.platform)
    for (const row of page) {
      if (!ids.has(row.userId)) continue
      const name = knownName(row.username, row.userId)
      if (name) seenHere.set(row.userId, name)
    }

    const now = Date.now()
    const pending = new Map<string, string>()
    for (const id of ids) {
      const local = seenHere.get(id)
      if (!hasQqDirectory && local) {
        names.set(id, local)
        continue
      }
      const key = JSON.stringify([
        scope.platform,
        scope.selfId,
        scope.channelId,
        id,
      ])
      const hit = cache.get(key)
      if (hit && hit.expires > now) {
        if (hit.name) names.set(id, hit.name)
      } else {
        pending.set(id, key)
      }
    }
    // QQ's adapter-level user lookup sends OpenIDs to a third-party service.
    if (pending.size && hasQqDirectory) {
      const users = await ctx.database.get(
        'qqbot_user',
        {
          platform: scope.platform,
          selfId: scope.selfId,
          id: [...pending.keys()],
        },
        ['id', 'name']
      )
      for (const user of users) {
        const name = knownName(user.name, user.id)
        if (name) names.set(user.id, name)
      }
    }

    for (const [id, name] of seenHere) {
      if (!names.has(id)) names.set(id, name)
    }

    const missing = [...pending.keys()].filter((id) => !names.has(id))
    if (missing.length) {
      const speakers = await ctx.database
        .select('channel_message', {
          ...scope,
          userId: missing,
          username: { $ne: '' },
          recalled: { $ne: true },
        })
        .groupBy(['userId', 'username'], { lastAt: (row) => $.max(row.time) })
        .orderBy('lastAt', 'desc')
        .execute()
      for (const row of speakers) {
        const name = knownName(row.username, row.userId)
        if (name && !names.has(row.userId)) names.set(row.userId, name)
      }
    }

    for (const [id, key] of pending) {
      cache.delete(key)
      if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!)
      cache.set(key, { name: names.get(id), expires: now + CACHE_TTL })
    }
    return names
  }
}
