import { Context } from 'koishi'

import { resolve } from 'node:path'

import '@koishijs/console'

/**
 * Console page for the v5 channel manager: which groups the official QQ bot is
 * in, who has DMed it, and switches to activate them. All listeners require
 * authority 4 (ops). Never returns message content.
 */
const AUTH = 4
const PLATFORM = 'qq'

export const name = 'qqbot-admin'
export const inject = ['console', 'database', 'qqbot']

type Status = 'all' | 'active' | 'inactive'

interface GroupRow {
  selfId: string
  id: string
  name: string
  memberNum: number
  role: string
  recvSetting: string
  allowProactive: boolean
  recvRejected: boolean
  addedBy: string
  firstSeen: number | null
  lastSeen: number | null
  messageCount: number
  removedAt: number | null
  noticeSentAt: number | null
  noticePending: boolean
  active: boolean
}

interface UserRow {
  selfId: string
  id: string
  name: string
  firstSeen: number | null
  lastSeen: number | null
  messageCount: number
  dmCount: number
  dmActive: boolean
  /** Koishi account this openid is bound to, if any. */
  account: { id: number; name: string; authority: number } | null
  isOp: boolean
}

interface MemberRow {
  selfId: string
  channelId: string
  channelName: string
  userId: string
  userName: string
  firstSeen: number | null
  lastSeen: number | null
  messageCount: number
}

declare module '@koishijs/console' {
  interface Events {
    'qqbot-admin/groups'(payload: { status?: Status; q?: string }): GroupRow[]
    'qqbot-admin/users'(payload: { status?: Status; q?: string }): UserRow[]
    'qqbot-admin/members'(payload: {
      selfId: string
      channelId?: string
      userId?: string
    }): MemberRow[]
    'qqbot-admin/toggle-group'(payload: {
      selfId: string
      id: string
      active: boolean
    }): { ok: true }
    'qqbot-admin/toggle-dm'(payload: {
      selfId: string
      id: string
      active: boolean
    }): { ok: true }
    'qqbot-admin/refresh-group'(payload: { selfId: string; id: string }): {
      ok: true
    }
    'qqbot-admin/set-op'(payload: { id: string; op: boolean }): {
      ok: boolean
      message?: string
    }
  }
}

const ts = (d?: Date | null) => (d ? new Date(d).valueOf() : null)

function matches(q: string | undefined, ...fields: (string | undefined)[]) {
  if (!q) return true
  const needle = q.trim().toLowerCase()
  return fields.some((f) => f?.toLowerCase().includes(needle))
}

export function apply(ctx: Context) {
  ctx.console.addListener(
    'qqbot-admin/groups',
    async ({ status = 'all', q }: { status?: Status; q?: string } = {}) => {
      const rows = await ctx.database.get('qqbot_channel', { platform: PLATFORM })
      const channels = await ctx.database.get(
        'channel',
        { platform: PLATFORM, id: rows.map((r) => r.id) },
        ['id', 'assignee']
      )
      const assignee = new Map(channels.map((c) => [c.id, c.assignee]))
      return rows
        .map<GroupRow>((r) => ({
          selfId: r.selfId,
          id: r.id,
          name: r.name ?? '',
          memberNum: r.memberNum ?? 0,
          role: r.role ?? '',
          recvSetting: r.recvSetting ?? '',
          allowProactive: !!r.allowProactive,
          recvRejected: !!r.recvRejected,
          addedBy: r.addedBy ?? '',
          firstSeen: ts(r.firstSeen),
          lastSeen: ts(r.lastSeen),
          messageCount: r.messageCount ?? 0,
          removedAt: ts(r.removedAt),
          noticeSentAt: ts(r.noticeSentAt),
          noticePending: !!r.noticePending,
          active: assignee.get(r.id) === r.selfId,
        }))
        .filter((r) =>
          status === 'all' ? true : status === 'active' ? r.active : !r.active
        )
        .filter((r) => matches(q, r.name, r.id))
        .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
    },
    { authority: AUTH }
  )

  ctx.console.addListener(
    'qqbot-admin/users',
    async ({ status = 'all', q }: { status?: Status; q?: string } = {}) => {
      const rows = await ctx.database.get('qqbot_user', { platform: PLATFORM })
      const bindings = await ctx.database.get(
        'binding',
        { platform: PLATFORM, pid: rows.map((r) => r.id) },
        ['pid', 'aid']
      )
      const users = await ctx.database.get(
        'user',
        { id: bindings.map((b) => b.aid) },
        ['id', 'name', 'authority']
      )
      const userById = new Map(users.map((u) => [u.id, u]))
      const accountOf = new Map(
        bindings.map((b) => [b.pid, userById.get(b.aid) ?? null])
      )
      return rows
        .map<UserRow>((r) => {
          const account = accountOf.get(r.id) ?? null
          const isOp = (account?.authority ?? 0) >= 4
          return {
            selfId: r.selfId,
            id: r.id,
            name: r.name ?? '',
            firstSeen: ts(r.firstSeen),
            lastSeen: ts(r.lastSeen),
            messageCount: r.messageCount ?? 0,
            dmCount: r.dmCount ?? 0,
            dmActive: !!r.dmActive,
            account: account
              ? {
                  id: account.id,
                  name: account.name ?? '',
                  authority: account.authority ?? 0,
                }
              : null,
            isOp,
          }
        })
        .filter((r) => {
          const served = r.dmActive || r.isOp
          return status === 'all' ? true : status === 'active' ? served : !served
        })
        .filter((r) => matches(q, r.name, r.id, r.account?.name))
        .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
    },
    { authority: AUTH }
  )

  ctx.console.addListener(
    'qqbot-admin/members',
    async ({ selfId, channelId, userId }) => {
      const query: Record<string, string> = { selfId }
      if (channelId) query.channelId = channelId
      if (userId) query.userId = userId
      const rows = await ctx.database.get('qqbot_member', query)
      const channels = await ctx.database.get(
        'qqbot_channel',
        { selfId, id: [...new Set(rows.map((r) => r.channelId))] },
        ['id', 'name']
      )
      const users = await ctx.database.get(
        'qqbot_user',
        { selfId, id: [...new Set(rows.map((r) => r.userId))] },
        ['id', 'name']
      )
      const channelName = new Map(channels.map((c) => [c.id, c.name ?? '']))
      const userName = new Map(users.map((u) => [u.id, u.name ?? '']))
      return rows
        .map<MemberRow>((r) => ({
          selfId: r.selfId,
          channelId: r.channelId,
          channelName: channelName.get(r.channelId) ?? '',
          userId: r.userId,
          userName: userName.get(r.userId) ?? '',
          firstSeen: ts(r.firstSeen),
          lastSeen: ts(r.lastSeen),
          messageCount: r.messageCount ?? 0,
        }))
        .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
    },
    { authority: AUTH }
  )

  ctx.console.addListener(
    'qqbot-admin/toggle-group',
    async ({ selfId, id, active }) => {
      if (active) await ctx.qqbot.activateGroup(PLATFORM, selfId, id)
      else await ctx.qqbot.deactivateGroup(PLATFORM, selfId, id)
      return { ok: true }
    },
    { authority: AUTH }
  )

  ctx.console.addListener(
    'qqbot-admin/toggle-dm',
    async ({ selfId, id, active }) => {
      await ctx.qqbot.setDmActive(PLATFORM, selfId, id, active)
      return { ok: true }
    },
    { authority: AUTH }
  )

  ctx.console.addListener(
    'qqbot-admin/refresh-group',
    async ({ selfId, id }) => {
      await ctx.qqbot.metadata.refreshGroup(selfId, id)
      return { ok: true }
    },
    { authority: AUTH }
  )

  ctx.console.addListener(
    'qqbot-admin/set-op',
    async ({ id, op }) => ctx.qqbot.setOp(PLATFORM, id, op),
    { authority: AUTH }
  )

  const clientDir = resolve(
    ctx.baseDir,
    'node_modules/koishi-plugin-qqbot-admin/client'
  )
  ctx.console.addEntry({ dev: clientDir, prod: clientDir })
}
