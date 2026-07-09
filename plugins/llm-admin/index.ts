import { Context } from 'koishi'

import { resolve } from 'node:path'

import '@koishijs/console'

import { type UserOverview, type UserUsageRow, aggregateUserOverview } from './aggregate-user'
import { matchUser, paginate } from './filters'

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
    'llm-admin/overview'(payload: { id: number }): UserOverview | null
    'llm-admin/sessions'(payload: {
      id: number
      limit?: number
      offset?: number
    }): { total: number; rows: SessionRow[] }
    'llm-admin/session'(payload: { conversationId: string }): ChatMsg[]
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

      const identity = { id, name: nameMap.get(id) || '', account: acctMap.get(id) || '' }
      return aggregateUserOverview(rows, sessionsOfUser.length, identity, Date.now())
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

  // ---- 会话消息：chat 式回放 ----
  ctx.console.addListener(
    'llm-admin/session',
    async ({ conversationId }) => {
      const rows = (await db.get(
        'openai_chat',
        { conversation_id: conversationId },
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

      return rows.map((r): ChatMsg => {
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
    },
    { authority: AUTH }
  )

  const clientDir = resolve(
    ctx.baseDir,
    'node_modules/koishi-plugin-llm-admin/client'
  )
  ctx.console.addEntry({ dev: clientDir, prod: clientDir })
}
