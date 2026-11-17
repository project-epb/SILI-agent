import { Context } from 'koishi'

import { resolve } from 'node:path'

import '@koishijs/console'

import type { MemoryTier } from '../../src/plugins/llm/tools/read-user-memory'

import {
  type Usage,
  type UserOverview,
  type UserUsageRow,
  aggregateUserOverview,
} from './aggregate-user'
import { matchUser, paginate } from './filters'
import { parseEnvelopes, splitSteer } from './envelope'
import { checkMemoryWrite, utf8ByteLength } from './memory-edit'
import { turnWindow } from './turns'

// ⚠ 隐私敏感：本插件暴露用户长期记忆与会话正文，authority 4（仅 sysop）门控所有
// listener（读也拦），且服务端日志不落记忆/会话正文。这是原型 spike，正式版走 spec。

const AUTH = 4

export const name = 'llm-admin'
export const inject = ['console', 'database', 'llm']

// ---- 类型（供前端参考） ----
/** A user, or a group whose members share one conversation. */
interface AdminUser {
  /** User id, or `group:<platform>:<channel>` (see groupOf). */
  id: number | string
  name: string
  account: string
}
/** One row of the subject list: a user or a group, with its usage at a glance. */
interface SubjectRow extends AdminUser {
  kind: 'user' | 'group'
  /** Every bound account (`platform:pid`), or the group's `platform:channel`. */
  accounts: string[]
  lastActive: number | null
  sessions: number
  calls: number
  totalTokens: number
  /** Private + shared record size in bytes; null for groups and users without either. */
  memoryBytes: number | null
}
interface SessionRow {
  conversationId: string
  title: string
  startedAt: number
  lastUsedAt: number
  isCurrent: boolean
  isCompacted: boolean
  turns: number
}
type ChatMsg = { time: number } & (
  | {
      role: 'user'
      content: string
      speaker?: string
      raw?: string
      /** Arrived while SILI was working; it read it from a tool result. */
      steered?: boolean
    }
  | { role: 'system'; content: string }
  | {
      role: 'assistant'
      content: string
      reasoning?: string
      toolCalls?: string
      usage?: Usage | null // 该次 agent 调用的 token 消耗，供逐条展示
      model?: string // 该次 agent 调用所用模型，供逐条展示
    }
  | { role: 'tool'; toolName?: string; content: string }
)

declare module '@koishijs/console' {
  interface Events {
    'llm-admin/search'(payload: {
      q: string
      kind?: 'all' | 'user' | 'group'
      limit?: number
      offset?: number
    }): { total: number; users: SubjectRow[] }
    'llm-admin/overview'(payload: { id: number | string }): UserOverview
    'llm-admin/sessions'(payload: {
      id: number | string
      limit?: number
      offset?: number
    }): { total: number; rows: SessionRow[] }
    'llm-admin/session'(payload: {
      conversationId: string
      limit?: number
      beforeTurn?: number | null
    }): { messages: ChatMsg[]; earliestTurn: number | null; hasMore: boolean }
    // 隐私敏感：读也需 authority 4。content 绝不落服务端日志。
    'llm-admin/memory-get'(payload: { id: number; tier?: MemoryTier }): {
      content: string
      byteSize: number
      updateCount: number
      lastUpdated: number | null
      platform: string | null
      hardLimit: number
    }
    'llm-admin/memory-save'(payload: {
      id: number
      tier?: MemoryTier
      content: string
    }): {
      ok: boolean
      byteSize: number
      error?: string
    }
    'llm-admin/memory-clear'(payload: { id: number; tier?: MemoryTier }): {
      ok: boolean
    }
    // 写操作：强制轮转 session（纯新开，不压缩、不带 prev_session_id）。
    'llm-admin/rotate'(payload: { id: number | string }): {
      ok: true
      conversationId: string
    }
  }
}

const GROUP_OWNER = 0

/** `group:<platform>:<channel>` → its parts; null for a user id. */
function groupOf(id: number | string) {
  if (typeof id !== 'string' || !id.startsWith('group:')) return null
  const [, platform, ...rest] = id.split(':')
  return { platform, channelId: rest.join(':') }
}

export function apply(ctx: Context) {
  const db = ctx.database

  /** openai_session filter for a user's or a group's conversations. */
  function sessionsQuery(id: number | string) {
    const group = groupOf(id)
    return group
      ? {
          conversation_owner: GROUP_OWNER,
          platform: group.platform,
          user_id: group.channelId,
        }
      : { conversation_owner: Number(id) }
  }

  async function currentConversation(id: number | string) {
    const group = groupOf(id)
    const [row] = group
      ? await db.get(
          'channel',
          { platform: group.platform, id: group.channelId },
          { fields: ['openai_last_conversation_id'] }
        )
      : await db.get(
          'user',
          { id: Number(id) },
          { fields: ['openai_last_conversation_id'] }
        )
    return (row as any)?.openai_last_conversation_id ?? ''
  }

  /** Groups with a shared conversation, named after the QQ group when known. */
  async function groupCandidates(): Promise<AdminUser[]> {
    const rows = await db.get(
      'openai_session',
      { conversation_owner: GROUP_OWNER },
      { fields: ['platform', 'user_id'] }
    )
    const seen = new Map<string, { platform: string; channelId: string }>()
    for (const r of rows) {
      seen.set(`group:${r.platform}:${r.user_id}`, {
        platform: r.platform,
        channelId: r.user_id,
      })
    }
    const names = new Map<string, string>()
    try {
      const channels = await db.get(
        'qqbot_channel' as any,
        { id: [...seen.values()].map((g) => g.channelId) },
        { fields: ['id', 'name'] } as any
      )
      for (const c of channels as any[]) names.set(c.id, c.name)
    } catch {
      // qqbot_channel only exists under the v5 profile.
    }
    return [...seen].map(([id, g]) => ({
      id,
      name: names.get(g.channelId) || '(群)',
      account: `${g.platform}:${g.channelId}`,
    }))
  }

  // 身份解析（复刻仪表盘：user.name + 首个 binding platform:pid）
  async function resolveIdentities(ids: number[]) {
    const nameMap = new Map<number, string>()
    const acctMap = new Map<number, string>()
    if (!ids.length) return { nameMap, acctMap }
    const users = await db.get('user', { id: ids }, { fields: ['id', 'name'] })
    for (const u of users) nameMap.set(u.id, u.name)
    const bindings = await db.get(
      'binding',
      { aid: ids },
      { fields: ['aid', 'platform', 'pid', 'bid'] }
    )
    for (const b of [...bindings].sort((a, b) => a.bid - b.bid)) {
      if (!acctMap.has(b.aid)) acctMap.set(b.aid, `${b.platform}:${b.pid}`)
    }
    return { nameMap, acctMap }
  }

  // ---- 列表：有过会话的用户和群，按最近活跃倒序 ----
  // 搜索：#id 精确 / 账号子串 / 名称子串。表都不大（几千行），直接在内存里聚合。
  ctx.console.addListener(
    'llm-admin/search',
    async ({ q, kind = 'all', limit = 50, offset = 0 }) => {
      const sessions = await db.get('openai_session', {}, {
        fields: [
          'conversation_owner',
          'conversation_id',
          'platform',
          'user_id',
          'last_used_at',
        ],
      })
      const subjectOf = (s: (typeof sessions)[number]) =>
        s.conversation_owner === GROUP_OWNER
          ? `group:${s.platform}:${s.user_id}`
          : s.conversation_owner
      const stats = new Map<
        number | string,
        { sessions: number; lastActive: number; calls: number; tokens: number }
      >()
      const convSubject = new Map<string, number | string>()
      for (const s of sessions) {
        const key = subjectOf(s)
        const st = stats.get(key) ?? { sessions: 0, lastActive: 0, calls: 0, tokens: 0 }
        st.sessions++
        st.lastActive = Math.max(st.lastActive, s.last_used_at ?? 0)
        stats.set(key, st)
        convSubject.set(s.conversation_id, key)
      }
      const calls = (await db.get(
        'openai_chat',
        { role: 'assistant' },
        { fields: ['conversation_id', 'usage'] }
      )) as unknown as Array<{ conversation_id: string; usage?: Usage | null }>
      for (const c of calls) {
        const st = stats.get(convSubject.get(c.conversation_id) ?? '')
        if (!st) continue
        st.calls++
        st.tokens += c.usage?.totalTokens ?? 0
      }

      const userIds = [...stats.keys()].filter(
        (k): k is number => typeof k === 'number'
      )
      const [users, bindings, sharedMemories, memories, groups] = await Promise.all([
        db.get('user', { id: userIds }, { fields: ['id', 'name'] }),
        db.get('binding', { aid: userIds }, { fields: ['aid', 'platform', 'pid', 'bid'] }),
        db.get('openai_user_shared_memory' as any, { user_id: userIds.map(String) }, {
          fields: ['user_id', 'byte_size'],
        } as any),
        db.get('openai_user_memory', { user_id: userIds.map(String) }, {
          fields: ['user_id', 'byte_size'],
        } as any),
        groupCandidates(),
      ])
      const names = new Map(users.map((u) => [u.id, u.name]))
      const accounts = new Map<number, string[]>()
      for (const b of [...bindings].sort((x, y) => x.bid - y.bid)) {
        const list = accounts.get(b.aid) ?? []
        list.push(`${b.platform}:${b.pid}`)
        accounts.set(b.aid, list)
      }
      // A QQ-only user often has no Koishi name: use the name the bot saw.
      const qqPids = bindings.filter((b) => b.platform === 'qq').map((b) => b.pid)
      const qqNames = new Map<string, string>()
      try {
        const seen = await db.get('qqbot_user' as any, { id: qqPids }, {
          fields: ['id', 'name'],
        } as any)
        for (const u of seen as any[]) if (u.name) qqNames.set(u.id, u.name)
      } catch {
        // qqbot_user only exists under the v5 profile.
      }
      // Both records together: private + shared.
      const memoryBytes = new Map<number, number>()
      for (const m of [...(memories as any[]), ...(sharedMemories as any[])]) {
        const id = Number(m.user_id)
        memoryBytes.set(id, (memoryBytes.get(id) ?? 0) + (m.byte_size as number))
      }

      const rows: SubjectRow[] = []
      for (const [key, st] of stats) {
        const base = {
          lastActive: st.lastActive || null,
          sessions: st.sessions,
          calls: st.calls,
          totalTokens: st.tokens,
        }
        if (typeof key === 'number') {
          const accts = accounts.get(key) ?? []
          const qqName = accts
            .filter((a) => a.startsWith('qq:'))
            .map((a) => qqNames.get(a.slice(3)))
            .find(Boolean)
          rows.push({
            ...base,
            id: key,
            kind: 'user',
            name: names.get(key) || qqName || '',
            account: accts[0] ?? '',
            accounts: accts,
            memoryBytes: memoryBytes.get(key) ?? null,
          })
        } else {
          const g = groups.find((x) => x.id === key)
          rows.push({
            ...base,
            id: key,
            kind: 'group',
            name: g?.name ?? '(群)',
            account: g?.account ?? key,
            accounts: [g?.account ?? key],
            memoryBytes: null,
          })
        }
      }
      const filtered = rows
        .filter((r) => kind === 'all' || r.kind === kind)
        .filter((r) => matchUser({ ...r, account: r.accounts.join(' ') }, q))
        .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))
      const { total, page } = paginate(filtered, limit, offset)
      return { total, users: page }
    },
    { authority: AUTH }
  )

  // ---- 用户总览：使用量卡片 + 近30天趋势 + 模型分布 ----
  ctx.console.addListener(
    'llm-admin/overview',
    async ({ id }) => {
      const group = groupOf(id)
      const sessionsOfUser = await db.get('openai_session', sessionsQuery(id), {
        fields: ['id', 'conversation_id'],
      })
      // Group conversations all share owner 0: select by conversation id.
      const rows = (await db.get(
        'openai_chat',
        group
          ? {
              conversation_id: sessionsOfUser.map((s) => s.conversation_id),
              role: 'assistant',
            }
          : { conversation_owner: Number(id), role: 'assistant' },
        { fields: ['time', 'model', 'usage'] }
      )) as unknown as UserUsageRow[]

      let identity: AdminUser
      if (group) {
        identity = (await groupCandidates()).find((g) => g.id === id) ?? {
          id,
          name: '(群)',
          account: `${group.platform}:${group.channelId}`,
        }
      } else {
        const { nameMap, acctMap } = await resolveIdentities([Number(id)])
        identity = {
          id,
          name: nameMap.get(Number(id)) || '',
          account: acctMap.get(Number(id)) || '',
        }
      }
      return aggregateUserOverview(
        rows,
        sessionsOfUser.length,
        identity,
        Date.now()
      )
    },
    { authority: AUTH }
  )

  // ---- 会话列表：按最后活跃倒序 ----
  ctx.console.addListener(
    'llm-admin/sessions',
    async ({ id, limit = 30, offset = 0 }) => {
      const rows = await db.get(
        'openai_session',
        sessionsQuery(id),
        {
          fields: [
            'conversation_id',
            'user_first_msg',
            'started_at',
            'last_used_at',
            'prev_session_id',
          ],
        }
      )
      const currentConv = await currentConversation(id)

      const sorted = [...rows].sort((a, b) => b.last_used_at - a.last_used_at)
      const { total, page } = paginate(sorted, limit, offset)

      // 只对当前页 conversation_id 批量查一次轮数，避免 N+1
      const convIds = page.map((s) => s.conversation_id)
      const turnRows = convIds.length
        ? await db.get(
            'openai_chat',
            { conversation_id: convIds },
            { fields: ['conversation_id', 'turn_number'] }
          )
        : []
      const turnSet = new Map<string, Set<number>>()
      for (const t of turnRows) {
        const set = turnSet.get(t.conversation_id) ?? new Set<number>()
        set.add(t.turn_number)
        turnSet.set(t.conversation_id, set)
      }

      const out: SessionRow[] = page.map((s) => ({
        conversationId: s.conversation_id,
        title: s.user_first_msg || '(空)',
        startedAt: s.started_at,
        lastUsedAt: s.last_used_at,
        isCurrent: s.conversation_id === currentConv,
        isCompacted: !!s.prev_session_id,
        turns: turnSet.get(s.conversation_id)?.size ?? 0,
      }))
      return { total, rows: out }
    },
    { authority: AUTH }
  )

  // ---- 会话消息：chat 式回放（按 turn 窗口分页，前端无限上滚）----
  ctx.console.addListener(
    'llm-admin/session',
    async ({ conversationId, limit = 20, beforeTurn = null }) => {
      // 该会话所有 turn_number（升序去重）
      const allRows = await db.get(
        'openai_chat',
        { conversation_id: conversationId },
        { fields: ['turn_number'] }
      )
      const turns = [...new Set(allRows.map((r) => r.turn_number))].sort(
        (a, b) => a - b
      )
      const { fromTurn, hasMore } = turnWindow(turns, limit, beforeTurn)
      if (fromTurn == null)
        return { messages: [], earliestTurn: null, hasMore: false }

      const upper = beforeTurn == null ? Number.MAX_SAFE_INTEGER : beforeTurn
      const rows = (await db.get(
        'openai_chat',
        {
          conversation_id: conversationId,
          turn_number: { $gte: fromTurn, $lt: upper },
        },
        {
          fields: [
            'role',
            'content',
            'reasoning_content',
            'tool_calls',
            'tool_name',
            'time',
            'usage',
            'model',
          ],
          sort: { turn_number: 'asc', intra_turn_seq: 'asc', id: 'asc' },
        } as any
      )) as unknown as Array<{
        role: string
        content: string
        reasoning_content: string
        tool_calls: string
        tool_name: string
        time: number
        usage: Usage | null
        model: string
      }>

      // user 行存的是包装 envelope：取出说话人和正文。群会话一行可能
      // 有多条（上一轮没赶上的 steer 消息），逐条带上说话人。
      const extractUser = (c: string) => {
        const parts = parseEnvelopes(c)
        if (parts.length === 1) return parts[0]
        return {
          speaker: '多人',
          text: parts.map((p) => `${p.speaker || '?'}：${p.text}`).join('\n'),
        }
      }

      const messages = rows.flatMap((r): ChatMsg | ChatMsg[] => {
        if (r.role === 'user') {
          const { speaker, text } = extractUser(r.content)
          return {
            time: r.time,
            role: 'user',
            content: text,
            speaker: speaker || undefined,
            raw: r.content, // 完整 envelope（<turn_context> + <user_message>）供折叠查看
          }
        }
        if (r.role === 'system')
          return { time: r.time, role: 'system', content: r.content }
        if (r.role === 'tool') {
          const { tool, steered } = splitSteer(r.content)
          return [
            { time: r.time, role: 'tool', toolName: r.tool_name, content: tool },
            ...steered.map(
              (m): ChatMsg => ({
                time: r.time,
                role: 'user',
                content: m.text,
                speaker: m.speaker || undefined,
                steered: true,
              })
            ),
          ]
        }
        return {
          time: r.time,
          role: 'assistant',
          content: r.content,
          reasoning: r.reasoning_content || undefined,
          toolCalls: r.tool_calls || undefined,
          usage: r.usage ?? null,
          model: r.model || undefined,
        }
      })
      return { messages, earliestTurn: fromTurn, hasMore }
    },
    { authority: AUTH }
  )

  // ---- 长期记忆读/改/清（隐私敏感，仅 sysop；日志不落 content）----
  // 每位用户两份：private（openai_user_memory）与 shared（openai_user_shared_memory）。
  // 记忆键：(platform, user_id)。前端只传 aid，故先按 user_id 查现有行拿 platform；
  // 无现有行时从 binding 推断（onebot→qq 归一化）。
  const MEMORY_TABLE = {
    private: 'openai_user_memory',
    shared: 'openai_user_shared_memory',
  } as const
  async function memoryRow(id: number, tier: MemoryTier = 'private') {
    const rows = await db.get(MEMORY_TABLE[tier] as any, { user_id: String(id) })
    return (rows[0] as any) ?? null
  }
  async function memoryPlatform(id: number): Promise<string> {
    for (const tier of ['private', 'shared'] as const) {
      const existing = await memoryRow(id, tier)
      if (existing?.platform) return existing.platform
    }
    const bindings = await db.get(
      'binding',
      { aid: id },
      { fields: ['platform', 'bid'] }
    )
    const first = [...bindings].sort((x, y) => x.bid - y.bid)[0]
    const p = first?.platform
    return p === 'onebot' ? 'qq' : p || 'unknown'
  }

  ctx.console.addListener(
    'llm-admin/memory-get',
    async ({ id, tier = 'private' as MemoryTier }) => {
      const row = await memoryRow(id, tier)
      return {
        content: row?.content ?? '',
        byteSize: row?.byte_size ?? 0,
        updateCount: row?.update_count ?? 0,
        lastUpdated: row?.last_updated_at ?? null,
        platform: row?.platform ?? null,
        hardLimit: ctx.llm.getMemoryHardLimit(tier),
      }
    },
    { authority: AUTH }
  )

  ctx.console.addListener(
    'llm-admin/memory-save',
    async ({ id, tier = 'private' as MemoryTier, content }) => {
      const check = checkMemoryWrite(content, ctx.llm.getMemoryHardLimit(tier))
      if (!check.ok) return check
      const existing = await memoryRow(id, tier)
      const platform = existing?.platform ?? (await memoryPlatform(id))
      // Orphan guard: with no binding and no existing memory row, platform
      // falls back to 'unknown'. The llm runtime resolves a real platform (e.g.
      // 'qq') for live sessions, so an 'unknown' row would never be read back —
      // a silent orphan write. Reject with a diagnosable reason instead.
      if (platform === 'unknown')
        return {
          ok: false,
          byteSize: utf8ByteLength(content),
          error:
            '无法解析该用户的平台（无 binding 且无现有记忆行），写入将成为不会被读取的孤儿记忆行，已拒绝保存',
        }
      if (tier === 'shared') {
        await ctx.llm.sharedMemory.set(platform, String(id), content)
        return { ok: true, byteSize: utf8ByteLength(content) }
      }
      // 保留 fork 节流元数据，避免打乱后台记忆调度
      await ctx.llm.memory.set(
        platform,
        String(id),
        content,
        existing?.message_count_at_update ?? 0,
        existing?.last_forked_conversation_id ?? ''
      )
      return { ok: true, byteSize: utf8ByteLength(content) }
    },
    { authority: AUTH }
  )

  ctx.console.addListener(
    'llm-admin/memory-clear',
    async ({ id, tier = 'private' as MemoryTier }) => {
      // Same platform resolution as memory-save.
      const existing = await memoryRow(id, tier)
      const platform = existing?.platform ?? (await memoryPlatform(id))
      const ok = await ctx.llm.memoryStore(tier).delete(platform, String(id))
      return { ok }
    },
    { authority: AUTH }
  )

  // ---- 强制轮转 session（写操作，仅 sysop）----
  // 纯新开：mint 一个新 conversation_id，建全新 openai_session（不传
  // prevSessionId → prev_session_id 落空串，非压缩派生），把 user 的
  // openai_last_conversation_id 指向它，并同步在飞的 activeChats entry
  // （若该用户此刻正有 chat 在跑），避免打断进来读到旧 id 又分歧。
  // 复刻 commands/chat.tsx 的 idle-rotate 路径，但主动触发、且不做 summary。
  // 日志只记 id / 新旧 conversation_id，绝不落会话正文。
  ctx.console.addListener(
    'llm-admin/rotate',
    async ({ id }) => {
      const newId = crypto.randomUUID()
      const group = groupOf(id)
      if (group) {
        await ctx.llm.sessions.create({
          conversationId: newId,
          conversationOwner: GROUP_OWNER,
          platform: group.platform,
          userId: group.channelId,
          userFirstMsg: '', // fresh blank session; no seeded utterance
        })
        await db.set(
          'channel',
          { platform: group.platform, id: group.channelId },
          { openai_last_conversation_id: newId } as any
        )
      } else {
        await ctx.llm.sessions.create({
          conversationId: newId,
          conversationOwner: Number(id),
          platform: await memoryPlatform(Number(id)),
          userId: String(id),
          userFirstMsg: '', // fresh blank session; no seeded utterance
        })
        await db.set('user', { id: Number(id) }, {
          openai_last_conversation_id: newId,
        } as any)
      }
      // activeChats 的键与 id 同形（用户 id / group:<platform>:<channel>）；
      // 有在飞 chat 则把它写向新会话
      const active = ctx.llm.activeChats.get(id)
      if (active) active.conversationId = newId
      ctx
        .logger('llm-admin')
        .info('[rotate] %s rotated to fresh session %s', id, newId)
      return { ok: true, conversationId: newId }
    },
    { authority: AUTH }
  )

  const clientDir = resolve(
    ctx.baseDir,
    'node_modules/koishi-plugin-llm-admin/client'
  )
  ctx.console.addEntry({ dev: clientDir, prod: clientDir })
}
