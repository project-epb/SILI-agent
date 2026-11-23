import { $, Context, Query, Tables } from 'koishi'

import { resolve } from 'node:path'

import '@koishijs/console'

import type {} from '../../src/plugins/feature'

import type {
  QQBotChannel,
  QQBotMember,
  QQBotUser,
} from '../../src/plugins/qqbot/tables'

import { applyChat } from './chat'

/**
 * Console pages for recorded conversations and the v5 QQ channel manager.
 * All listeners require authority 4 (ops).
 */
const AUTH = 4
const PLATFORM = 'qq'

export const name = 'qqbot-admin'
export const inject = [
  'console',
  'database',
  'qqbot',
  'feature',
  'channelMessageHistory',
]

type Status = 'all' | 'active' | 'inactive'

const PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

interface PageArgs {
  page?: number
  pageSize?: number
}

interface DirectoryArgs extends PageArgs {
  status?: Status
  q?: string
  selfId?: string
  id?: string
}

interface MemberArgs extends PageArgs {
  selfId: string
  channelId?: string
  userId?: string
  q?: string
}

interface Page<T> {
  rows: T[]
  total: number
}

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
    'qqbot-admin/groups'(payload: DirectoryArgs): Page<GroupRow>
    'qqbot-admin/users'(payload: DirectoryArgs): Page<UserRow>
    'qqbot-admin/members'(payload: MemberArgs): Page<MemberRow>
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
    'qqbot-admin/set-authority'(payload: { id: string; authority: number }): {
      ok: boolean
      message?: string
    }
  }
}

const ts = (d?: Date | null) => (d ? new Date(d).valueOf() : null)

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Name contains the keyword, or the openid starts with it (case-insensitive). */
function searchQuery(q: string | undefined, nameField: 'name') {
  const needle = q?.trim()
  if (!needle) return
  const text = escapeRegExp(needle)
  return {
    $or: [
      { [nameField]: { $regex: new RegExp(text, 'i') } },
      { id: { $regex: new RegExp('^' + text, 'i') } },
    ],
  } as Query.Expr<any>
}

export function apply(ctx: Context) {
  applyChat(ctx, AUTH)

  /** Rows and total count of one page, newest activity first. */
  async function page<
    K extends 'qqbot_channel' | 'qqbot_user' | 'qqbot_member',
  >(
    table: K,
    query: Query<Tables[K]>,
    { page = 1, pageSize = PAGE_SIZE }: PageArgs
  ) {
    const size = Math.min(Math.max(1, pageSize), MAX_PAGE_SIZE)
    const [rows, total] = await Promise.all([
      ctx.database.get(table, query, {
        sort: { lastSeen: 'desc' } as any,
        offset: (Math.max(1, page) - 1) * size,
        limit: size,
      }),
      ctx.database
        .select(table, query)
        // $.sum(1) groups to a plain counter; $.count / $.length build arrays.
        .execute(() => $.sum(1)),
    ])
    return { rows: rows as Tables[K][], total: total as number }
  }

  ctx.console.addListener(
    'qqbot-admin/groups',
    async ({
      status = 'all',
      q,
      selfId,
      id,
      page: p,
      pageSize,
    }: DirectoryArgs = {}) => {
      const filters: Query.Expr<QQBotChannel>[] = [{ platform: PLATFORM }]
      if (selfId) filters.push({ selfId })
      if (id) filters.push({ id })
      if (status === 'active') filters.push({ activated: true })
      else if (status === 'inactive') filters.push({ activated: { $ne: true } })
      const search = searchQuery(q, 'name')
      if (search) filters.push(search)

      const { rows, total } = await page(
        'qqbot_channel',
        { $and: filters },
        { page: p, pageSize }
      )
      return {
        total,
        rows: rows.map<GroupRow>((r) => ({
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
          active: !!r.activated,
        })),
      }
    },
    { authority: AUTH }
  )

  ctx.console.addListener(
    'qqbot-admin/users',
    async ({
      status = 'all',
      q,
      selfId,
      id,
      page: p,
      pageSize,
    }: DirectoryArgs = {}) => {
      // Ops (authority >= 4) are few: resolve their openids up front.
      const opAccounts = await ctx.database.get(
        'user',
        { authority: { $gte: 4 } },
        ['id']
      )
      const opIds = opAccounts.length
        ? (
            await ctx.database.get(
              'binding',
              { platform: PLATFORM, aid: opAccounts.map((u) => u.id) },
              ['pid']
            )
          ).map((b) => b.pid)
        : []
      const served: Query.Expr<QQBotUser> = {
        $or: [{ dmActive: true }, { id: { $in: opIds } }],
      }
      const filters: Query.Expr<QQBotUser>[] = [{ platform: PLATFORM }]
      if (selfId) filters.push({ selfId })
      if (id) filters.push({ id })
      if (status === 'active') filters.push(served)
      else if (status === 'inactive') filters.push({ $not: served })

      const search = searchQuery(q, 'name')
      if (search) {
        // Also match the bound Koishi account's name.
        const named = await ctx.database.get(
          'user',
          { name: { $regex: new RegExp(escapeRegExp(q!.trim()), 'i') } },
          { fields: ['id'], limit: 200 }
        )
        const pids = named.length
          ? (
              await ctx.database.get(
                'binding',
                { platform: PLATFORM, aid: named.map((u) => u.id) },
                ['pid']
              )
            ).map((b) => b.pid)
          : []
        filters.push(
          pids.length ? { $or: [search, { id: { $in: pids } }] } : search
        )
      }

      const { rows, total } = await page(
        'qqbot_user',
        { $and: filters },
        { page: p, pageSize }
      )
      const bindings = rows.length
        ? await ctx.database.get(
            'binding',
            { platform: PLATFORM, pid: rows.map((r) => r.id) },
            ['pid', 'aid']
          )
        : []
      const users = bindings.length
        ? await ctx.database.get('user', { id: bindings.map((b) => b.aid) }, [
            'id',
            'name',
            'authority',
          ])
        : []
      const userById = new Map(users.map((u) => [u.id, u]))
      const accountOf = new Map(
        bindings.map((b) => [b.pid, userById.get(b.aid) ?? null])
      )
      return {
        total,
        rows: rows.map<UserRow>((r) => {
          const account = accountOf.get(r.id) ?? null
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
            isOp: (account?.authority ?? 0) >= 4,
          }
        }),
      }
    },
    { authority: AUTH }
  )

  ctx.console.addListener(
    'qqbot-admin/members',
    async ({
      selfId,
      channelId,
      userId,
      q,
      page: p,
      pageSize,
    }: MemberArgs) => {
      const query: Query.Expr<QQBotMember> = { selfId }
      if (channelId) query.channelId = channelId
      if (userId) query.userId = userId
      const needle = typeof q === 'string' ? q.trim().slice(0, 120) : ''
      if (needle) {
        const expression = { $regex: new RegExp(escapeRegExp(needle), 'i') }
        const matches = await ctx.database.get(
          'qqbot_user',
          {
            platform: PLATFORM,
            selfId,
            $or: [{ name: expression }, { id: expression }],
          },
          ['id']
        )
        if (
          !matches.length ||
          (userId && !matches.some((row) => row.id === userId))
        ) {
          return { rows: [], total: 0 }
        }
        if (!userId) query.userId = matches.map((row) => row.id)
      }
      const { rows, total } = await page('qqbot_member', query, {
        page: p,
        pageSize,
      })
      const channels = rows.length
        ? await ctx.database.get(
            'qqbot_channel',
            { selfId, id: [...new Set(rows.map((r) => r.channelId))] },
            ['id', 'name']
          )
        : []
      const users = rows.length
        ? await ctx.database.get(
            'qqbot_user',
            { selfId, id: [...new Set(rows.map((r) => r.userId))] },
            ['id', 'name']
          )
        : []
      const channelName = new Map(channels.map((c) => [c.id, c.name ?? '']))
      const userName = new Map(users.map((u) => [u.id, u.name ?? '']))
      return {
        total,
        rows: rows.map<MemberRow>((r) => ({
          selfId: r.selfId,
          channelId: r.channelId,
          channelName: channelName.get(r.channelId) ?? '',
          userId: r.userId,
          userName: userName.get(r.userId) ?? '',
          firstSeen: ts(r.firstSeen),
          lastSeen: ts(r.lastSeen),
          messageCount: r.messageCount ?? 0,
        })),
      }
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
      await ctx.qqbot.metadata.queueRefresh(selfId, id)
      return { ok: true }
    },
    { authority: AUTH }
  )

  // The operator is the account logged into the console (plugin-auth).
  ctx.console.addListener(
    'qqbot-admin/set-authority',
    async function ({ id, authority }) {
      const auth = (this as any)?.auth
      if (!auth) return { ok: false, message: '未登录控制台。' }
      return ctx.qqbot.setAuthority(PLATFORM, id, authority, {
        id: auth.id,
        authority: auth.authority,
      })
    },
    { authority: AUTH }
  )

  // Service levels (feature plugin) of one group or DM. A DM's chat id is
  // `private:<user id>`; its level is 1 when served (op or activated).
  const chatOf = ({ selfId, id, kind }: { selfId: string; id: string; kind: 'group' | 'dm' }) =>
    kind === 'dm'
      ? {
          chatId: `private:${id}`,
          level: ctx.qqbot.state.isDmAllowed(PLATFORM, selfId, id) ? 1 : 0,
        }
      : {
          chatId: id,
          level: ctx.qqbot.state.isGroupActive(PLATFORM, selfId, id) ? 1 : 0,
        }

  ctx.console.addListener(
    'qqbot-admin/features',
    async (target) => {
      const { chatId, level } = chatOf(target)
      return { level, rows: ctx.feature.list(PLATFORM, chatId, level) }
    },
    { authority: AUTH }
  )

  ctx.console.addListener(
    'qqbot-admin/feature-override',
    async ({ name, action, ...target }) => {
      const { chatId, level } = chatOf(target as Parameters<typeof chatOf>[0])
      await ctx.feature.override(PLATFORM, chatId, level, name, action)
      return { ok: true }
    },
    { authority: AUTH }
  )

  const clientDir = resolve(
    ctx.baseDir,
    'node_modules/koishi-plugin-qqbot-admin/client'
  )
  ctx.console.addEntry({ dev: clientDir, prod: clientDir })
}
