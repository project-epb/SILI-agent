import { Context } from 'koishi'

import { resolve } from 'node:path'

import '@koishijs/console'

// ⚠ 隐私敏感：本插件暴露用户长期记忆与会话正文，authority 4（仅 sysop）门控所有
// listener（读也拦），且服务端日志不落记忆/会话正文。这是原型 spike，正式版走 spec。

const AUTH = 4
const DAY = 86_400_000

export const name = 'llm-admin'
export const inject = ['console', 'database', 'llm']

// ---- 类型（供前端参考） ----
interface AdminUser {
  id: number
  name: string
  account: string
}
interface UserOverview extends AdminUser {
  sessionCount: number
  firstActive: number | null
  lastActive: number | null
  calls: number
  totalTokens: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  models: Array<{ model: string; calls: number; totalTokens: number }>
  trend: Array<{ date: string; promptTokens: number; completionTokens: number }>
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
    'llm-admin/search'(payload: { q: string }): AdminUser[]
    'llm-admin/overview'(payload: { id: number }): UserOverview | null
    'llm-admin/sessions'(payload: { id: number }): SessionRow[]
    'llm-admin/session'(payload: { conversationId: string }): ChatMsg[]
  }
}

interface Usage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cachedTokens?: number
}
// cachedTokens ⊂ promptTokens — 展示用，不计入 total。
function tok(u: Usage | null) {
  const prompt = u?.promptTokens ?? 0
  const completion = u?.completionTokens ?? 0
  const cached = u?.cachedTokens ?? 0
  return {
    prompt,
    completion,
    cached,
    total: u?.totalTokens ?? prompt + completion,
  }
}

function localDate(time: number): string {
  const d = new Date(time)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
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
    async ({ q }) => {
      const query = (q ?? '').trim().toLowerCase()
      // 候选池 = 有过会话的用户
      const sessions = await db.get(
        'openai_session',
        {},
        { fields: ['conversation_owner'] }
      )
      const ids = [...new Set(sessions.map((s) => s.conversation_owner))]
      const { nameMap, acctMap } = await resolveIdentities(ids)
      const all: AdminUser[] = ids.map((id) => ({
        id,
        name: nameMap.get(id) || '',
        account: acctMap.get(id) || '',
      }))
      const matched = !query
        ? all
        : all.filter(
            (u) =>
              `#${u.id}` === query ||
              String(u.id) === query ||
              u.account.toLowerCase().includes(query) ||
              u.name.toLowerCase().includes(query)
          )
      return matched.sort((a, b) => a.id - b.id).slice(0, 50)
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
      )) as unknown as Array<{
        time: number
        model: string
        usage: Usage | null
      }>
      const sessionsOfUser = await db.get(
        'openai_session',
        { conversation_owner: id },
        { fields: ['id'] }
      )

      let totalTokens = 0
      let promptTokens = 0
      let completionTokens = 0
      let cachedTokens = 0
      let firstActive: number | null = null
      let lastActive: number | null = null
      const byModel = new Map<string, { calls: number; totalTokens: number }>()
      const now = Date.now()
      const since = now - 30 * DAY
      const byDay = new Map<
        string,
        { promptTokens: number; completionTokens: number }
      >()

      for (const r of rows) {
        const t = tok(r.usage)
        totalTokens += t.total
        promptTokens += t.prompt
        completionTokens += t.completion
        cachedTokens += t.cached
        if (firstActive === null || r.time < firstActive) firstActive = r.time
        if (lastActive === null || r.time > lastActive) lastActive = r.time
        const m = byModel.get(r.model) ?? { calls: 0, totalTokens: 0 }
        m.calls += 1
        m.totalTokens += t.total
        byModel.set(r.model, m)
        if (r.time >= since) {
          const key = localDate(r.time)
          const b = byDay.get(key) ?? { promptTokens: 0, completionTokens: 0 }
          b.promptTokens += t.prompt
          b.completionTokens += t.completion
          byDay.set(key, b)
        }
      }

      const trend: UserOverview['trend'] = []
      for (
        let d = new Date(since);
        d.getTime() <= now;
        d.setDate(d.getDate() + 1)
      ) {
        const key = localDate(d.getTime())
        trend.push({
          date: key,
          ...(byDay.get(key) ?? { promptTokens: 0, completionTokens: 0 }),
        })
      }

      const overview: UserOverview = {
        id,
        name: nameMap.get(id) || '',
        account: acctMap.get(id) || '',
        sessionCount: sessionsOfUser.length,
        firstActive,
        lastActive,
        calls: rows.length,
        totalTokens,
        promptTokens,
        completionTokens,
        cachedTokens,
        models: [...byModel.entries()]
          .map(([model, v]) => ({ model, ...v }))
          .sort((a, b) => b.totalTokens - a.totalTokens),
        trend,
      }
      return overview
    },
    { authority: AUTH }
  )

  // ---- 会话列表：按最后活跃倒序 ----
  ctx.console.addListener(
    'llm-admin/sessions',
    async ({ id }) => {
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
      // 每会话轮数（去重 turn_number）
      const result: SessionRow[] = []
      for (const s of rows) {
        const chatRows = await db.get(
          'openai_chat',
          { conversation_id: s.conversation_id },
          { fields: ['turn_number'] }
        )
        const turns = new Set(chatRows.map((c) => c.turn_number)).size
        result.push({
          conversationId: s.conversation_id,
          title: s.user_first_msg || '(空)',
          startedAt: s.started_at,
          lastUsedAt: s.last_used_at,
          isCurrent: s.conversation_id === currentConv,
          isCompacted: !!s.prev_session_id,
          turns,
        })
      }
      return result.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
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
