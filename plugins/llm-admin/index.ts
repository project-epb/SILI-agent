import { Context } from 'koishi'

import { resolve } from 'node:path'

import '@koishijs/console'

import {
  type UserOverview,
  type UserUsageRow,
  aggregateUserOverview,
} from './aggregate-user'
import { matchUser, paginate } from './filters'
import { checkMemoryWrite, utf8ByteLength } from './memory-edit'
import { turnWindow } from './turns'

// ⚠ 隐私敏感：本插件暴露用户长期记忆与会话正文，authority 4（仅 sysop）门控所有
// listener（读也拦），且服务端日志不落记忆/会话正文。这是原型 spike，正式版走 spec。

const AUTH = 4

export const name = 'llm-admin'
export const inject = ['console', 'database', 'llm']

// ---- 类型（供前端参考） ----
interface AdminUser {
  id: number
  name: string
  account: string
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
  | { role: 'user'; content: string; raw?: string }
  | { role: 'system'; content: string }
  | {
      role: 'assistant'
      content: string
      reasoning?: string
      toolCalls?: string
    }
  | { role: 'tool'; toolName?: string; content: string }
)

declare module '@koishijs/console' {
  interface Events {
    'llm-admin/search'(payload: {
      q: string
      limit?: number
      offset?: number
    }): { total: number; users: AdminUser[] }
    'llm-admin/overview'(payload: { id: number }): UserOverview
    'llm-admin/sessions'(payload: {
      id: number
      limit?: number
      offset?: number
    }): { total: number; rows: SessionRow[] }
    'llm-admin/session'(payload: {
      conversationId: string
      limit?: number
      beforeTurn?: number | null
    }): { messages: ChatMsg[]; earliestTurn: number | null; hasMore: boolean }
    // 隐私敏感：读也需 authority 4。content 绝不落服务端日志。
    'llm-admin/memory-get'(payload: { id: number }): {
      content: string
      byteSize: number
      updateCount: number
      lastUpdated: number | null
      platform: string | null
      hardLimit: number
    }
    'llm-admin/memory-save'(payload: { id: number; content: string }): {
      ok: boolean
      byteSize: number
      error?: string
    }
    'llm-admin/memory-clear'(payload: { id: number }): { ok: boolean }
    // 写操作：强制轮转 session（纯新开，不压缩、不带 prev_session_id）。
    'llm-admin/rotate'(payload: { id: number }): {
      ok: true
      conversationId: string
    }
  }
}

export function apply(ctx: Context) {
  const db = ctx.database

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

  // ---- 搜索：#id 精确 / platform:pid 子串 / 昵称子串 ----
  ctx.console.addListener(
    'llm-admin/search',
    async ({ q, limit = 50, offset = 0 }) => {
      // 候选池 = 有过会话的用户
      const sessions = await db.get(
        'openai_session',
        {},
        { fields: ['conversation_owner'] }
      )
      const ids = [...new Set(sessions.map((s) => s.conversation_owner))]
      const { nameMap, acctMap } = await resolveIdentities(ids)
      const all: AdminUser[] = ids
        .map((id) => ({
          id,
          name: nameMap.get(id) || '',
          account: acctMap.get(id) || '',
        }))
        .filter((u) => matchUser(u, q))
        .sort((a, b) => a.id - b.id)
      const { total, page } = paginate(all, limit, offset)
      return { total, users: page }
    },
    { authority: AUTH }
  )

  // ---- 用户总览：使用量卡片 + 近30天趋势 + 模型分布 ----
  ctx.console.addListener(
    'llm-admin/overview',
    async ({ id }) => {
      const { nameMap, acctMap } = await resolveIdentities([id])
      const rows = (await db.get(
        'openai_chat',
        { conversation_owner: id, role: 'assistant' },
        { fields: ['time', 'model', 'usage'] }
      )) as unknown as UserUsageRow[]
      const sessionsOfUser = await db.get(
        'openai_session',
        { conversation_owner: id },
        { fields: ['id'] }
      )

      const identity = {
        id,
        name: nameMap.get(id) || '',
        account: acctMap.get(id) || '',
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
        { conversation_owner: id },
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
      const user = await db.get(
        'user',
        { id },
        { fields: ['openai_last_conversation_id'] }
      )
      const currentConv = (user[0] as any)?.openai_last_conversation_id ?? ''

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
      }>

      // user 行存的是包装 envelope，抽取 <user_message> 内层供展示
      const extractUser = (c: string) => {
        const m = c.match(/<user_message>([\s\S]*?)<\/user_message>/)
        return (m ? m[1] : c).trim()
      }

      const messages = rows.map((r): ChatMsg => {
        if (r.role === 'user')
          return {
            time: r.time,
            role: 'user',
            content: extractUser(r.content),
            raw: r.content, // 完整 envelope（<turn_context> + <user_message>）供折叠查看
          }
        if (r.role === 'system')
          return { time: r.time, role: 'system', content: r.content }
        if (r.role === 'tool')
          return {
            time: r.time,
            role: 'tool',
            toolName: r.tool_name,
            content: r.content,
          }
        return {
          time: r.time,
          role: 'assistant',
          content: r.content,
          reasoning: r.reasoning_content || undefined,
          toolCalls: r.tool_calls || undefined,
        }
      })
      return { messages, earliestTurn: fromTurn, hasMore }
    },
    { authority: AUTH }
  )

  // ---- 长期记忆读/改/清（隐私敏感，仅 sysop；日志不落 content）----
  // 记忆键：(platform, user_id)。前端只传 aid，故先按 user_id 查现有行拿 platform；
  // 无现有行时从 binding 推断（onebot→qq 归一化）。
  async function memoryRow(id: number) {
    const rows = await db.get('openai_user_memory', { user_id: String(id) })
    return rows[0] ?? null
  }
  async function memoryPlatform(id: number): Promise<string> {
    const existing = await memoryRow(id)
    if (existing?.platform) return existing.platform
    const bindings = await db.get(
      'binding',
      { aid: id },
      { fields: ['platform', 'bid'] }
    )
    const first = [...bindings].sort((x, y) => x.bid - y.bid)[0]
    const p = first?.platform
    return p === 'onebot' ? 'qq' : p || 'unknown'
  }
  // getMemoryHardLimit() 在 llm 插件里是 private，此处按同一策略自算
  // （memory-fork.ts / index.tsx 均为 ceil(soft * 1.1)），避免上限漂移。
  function memoryHardLimit(): number {
    const soft = (ctx.llm as any).config?.memoryByteLimit ?? 3000
    return Math.ceil(soft * 1.1)
  }

  ctx.console.addListener(
    'llm-admin/memory-get',
    async ({ id }) => {
      const row = await memoryRow(id)
      return {
        content: row?.content ?? '',
        byteSize: row?.byte_size ?? 0,
        updateCount: row?.update_count ?? 0,
        lastUpdated: row?.last_updated_at ?? null,
        platform: row?.platform ?? null,
        hardLimit: memoryHardLimit(),
      }
    },
    { authority: AUTH }
  )

  ctx.console.addListener(
    'llm-admin/memory-save',
    async ({ id, content }) => {
      const check = checkMemoryWrite(content, memoryHardLimit())
      if (!check.ok) return check
      const existing = await memoryRow(id)
      const platform = existing?.platform ?? (await memoryPlatform(id))
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
    async ({ id }) => {
      const platform = await memoryPlatform(id)
      const ok = await ctx.llm.memory.delete(platform, String(id))
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
      const platform = await memoryPlatform(id)
      await ctx.llm.sessions.create({
        conversationId: newId,
        conversationOwner: id,
        platform,
        userId: String(id),
        userFirstMsg: '', // fresh blank session; no seeded utterance
      })
      await db.set('user', { id }, {
        openai_last_conversation_id: newId,
      } as any)
      // activeChats 按 owner id 键；有在飞 chat 则把它写向新会话
      const active = ctx.llm.activeChats.get(id)
      if (active) active.conversationId = newId
      ctx
        .logger('llm-admin')
        .info('[rotate] user #%d rotated to fresh session %s', id, newId)
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
