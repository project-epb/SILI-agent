import { $, Context, Time } from 'koishi'

import { qqAvatar } from '../../src/plugins/qqbot/avatar'
import { GUARDED_PLATFORMS } from '../../src/plugins/qqbot/gate'
import type { ChannelMessage } from '../../src/services/channel-message-history'

type Scope = Pick<ChannelMessage, 'platform' | 'selfId' | 'channelId'>
type Speaker = Pick<
  ChannelMessage,
  'userId' | 'username' | 'isSelf' | 'channelType'
>
const CACHE_TTL = Time.minute
const CACHE_SIZE = 2048

export interface ChatProfile {
  name?: string
  groupName?: string
  avatar?: string
  isBot?: boolean
}

export function knownName(value: unknown, id: string) {
  if (typeof value !== 'string') return
  const name = value.trim()
  return name && name !== id ? name : undefined
}

export function createChatProfileLookup(ctx: Context) {
  const cache = new Map<string, { profile?: ChatProfile; expires: number }>()

  return async function lookup(
    scope: Scope,
    mentioned: ReadonlySet<string>,
    page: readonly Speaker[]
  ) {
    const profiles = new Map<string, ChatProfile>()
    const seenHere = new Map<string, string>()
    const hasQqDirectory = GUARDED_PLATFORMS.has(scope.platform)
    const qqGroup =
      hasQqDirectory &&
      !scope.channelId.startsWith('private:') &&
      !page.some((row) => row.channelType === 'dm')
    const ids = new Set(mentioned)
    for (const row of page) {
      if (qqGroup && row.userId && !row.isSelf && row.userId !== scope.selfId)
        ids.add(row.userId)
      const name = knownName(row.username, row.userId)
      if (name) seenHere.set(row.userId, name)
    }
    if (!ids.size) return profiles

    const now = Date.now()
    const pending = new Map<string, string>()
    for (const id of ids) {
      const local = seenHere.get(id)
      if (!hasQqDirectory && local) {
        profiles.set(id, { name: local })
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
        if (hit.profile) profiles.set(id, { ...hit.profile })
      } else {
        pending.set(id, key)
      }
    }

    // QQ's adapter-level user lookup sends OpenIDs to a third-party service.
    if (pending.size && hasQqDirectory) {
      const selected = [...pending.keys()]
      const [accounts, members] = await Promise.all([
        ctx.database.get(
          'qqbot_user',
          {
            platform: scope.platform,
            selfId: scope.selfId,
            id: selected,
          },
          ['id', 'name', 'avatar', 'isBot']
        ),
        qqGroup
          ? ctx.database.get(
              'qqbot_member',
              {
                selfId: scope.selfId,
                channelId: scope.channelId,
                userId: selected,
              },
              ['userId', 'nickname']
            )
          : [],
      ])
      for (const account of accounts) {
        profiles.set(account.id, {
          name: knownName(account.name, account.id),
          avatar: qqAvatar(account.avatar),
          isBot: account.isBot ?? undefined,
        })
      }
      for (const member of members) {
        const groupName = knownName(member.nickname, member.userId)
        if (groupName)
          profiles.set(member.userId, {
            ...profiles.get(member.userId),
            groupName,
          })
      }
    }

    for (const id of ids) {
      const current = profiles.get(id)
      const name = seenHere.get(id)
      if (!current?.name && name) profiles.set(id, { ...current, name })
    }

    const missing = [...pending.keys()].filter((id) => {
      const profile = profiles.get(id)
      return !profile?.groupName && !profile?.name
    })
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
        const current = profiles.get(row.userId)
        if (name && !current?.name)
          profiles.set(row.userId, { ...current, name })
      }
    }

    for (const [id, key] of pending) {
      cache.delete(key)
      if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!)
      cache.set(key, { profile: profiles.get(id), expires: now + CACHE_TTL })
    }
    return profiles
  }
}
