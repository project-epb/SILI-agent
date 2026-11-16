import { $, Context, Time } from 'koishi'

import { resolve } from 'node:path'

import '@koishijs/console'

/**
 * User feedback. Only the chat LLM can submit it, through the
 * `submit_feedback` tool; there is deliberately no command, so nobody can
 * spam it directly. Maintainers read it on a console page (authority 4).
 */
const AUTH = 4
const TOOL_NAME = 'submit_feedback'
const DAILY_LIMIT = 3
const PAGE_SIZE = 50
/** Days are counted in China time, whatever the server's time zone. */
const UTC_OFFSET = 8 * Time.hour

export const name = 'feedback'
export const inject = ['console', 'database', 'llm']

type Source = 'requested' | 'observed'
type Category = 'bug' | 'suggestion' | 'other'

export interface Feedback {
  id: number
  uid: number
  platform: string
  userId: string
  channelId: string
  source: Source
  title: string
  summary: string
  category: Category
  original: string
  createdAt: Date
  handled: boolean
}

declare module 'koishi' {
  interface Tables {
    feedback: Feedback
  }
}

interface FeedbackRow extends Omit<Feedback, 'createdAt'> {
  createdAt: number
}

declare module '@koishijs/console' {
  interface Events {
    'feedback/list'(payload: { all?: boolean; page?: number }): {
      rows: FeedbackRow[]
      total: number
    }
    'feedback/set-handled'(payload: { id: number; handled: boolean }): {
      ok: true
    }
  }
}

const SOURCES: Source[] = ['requested', 'observed']
const CATEGORIES: Category[] = ['bug', 'suggestion', 'other']

const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description: [
    '把用户对 SILI 的反馈转交给维护者。维护者只能通过这里看到它们。',
    '',
    '**两种来源**：',
    '- `requested`：用户明确要求反馈（"帮我反馈一下"、"告诉你主人"）。提交后告诉用户已经转达。',
    '- `observed`：用户没要求，但聊天中暴露了问题——用户抱怨某个功能坏了、SILI 自己出错或答非所问、用户反复困惑于同一件事。静默提交，回复里不要提反馈这件事。',
    '',
    '**只提交**真实、具体、对维护者有用的内容。刷屏、辱骂、玩笑、无意义内容、纯闲聊不提交；用户要求提交这类内容时，礼貌拒绝即可。',
    '',
    `每个用户每天最多 ${DAILY_LIMIT} 条（两种来源合计）。`,
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', enum: SOURCES },
      category: { type: 'string', enum: CATEGORIES },
      title: { type: 'string', description: '一句话标题，30 字以内' },
      summary: {
        type: 'string',
        description:
          '写给维护者的完整描述：发生了什么、在哪个功能、复现方式或用户期望。润色成清楚的书面语。',
      },
      original: {
        type: 'string',
        description: '用户的原话，原样摘录，不改写',
      },
    },
    required: ['source', 'category', 'title', 'summary', 'original'],
    additionalProperties: false,
  },
}

/** Start of the current China-time day. */
function dayStart(now = Date.now()) {
  return new Date(now - ((now + UTC_OFFSET) % Time.day))
}

export function apply(ctx: Context) {
  ctx.model.extend(
    'feedback',
    {
      id: 'unsigned',
      uid: 'unsigned',
      platform: 'string(64)',
      userId: 'string(255)',
      channelId: 'string(255)',
      source: 'string(16)',
      title: 'string(255)',
      summary: 'text',
      category: 'string(16)',
      original: 'text',
      createdAt: 'timestamp',
      handled: 'boolean',
    },
    { autoInc: true }
  )

  ctx.llm.tools.register({
    definition: TOOL_DEFINITION,
    async execute(args, { session }) {
      const uid = (session.user as any)?.id as number | undefined
      if (!uid) return 'Error: no Koishi account for this user; skip.'
      const { source, category, title, summary, original } = args ?? {}
      if (!SOURCES.includes(source) || !CATEGORIES.includes(category)) {
        return `Error: source must be one of ${SOURCES.join('/')}, category one of ${CATEGORIES.join('/')}.`
      }
      for (const [key, value] of Object.entries({ title, summary, original })) {
        if (typeof value !== 'string' || !value.trim()) {
          return `Error: "${key}" must be a non-empty string.`
        }
      }
      const today = await ctx.database
        .select('feedback', { uid, createdAt: { $gte: dayStart() } })
        .execute(() => $.sum(1))
      if (today >= DAILY_LIMIT) {
        return source === 'requested'
          ? 'Not submitted: this user has used up today\'s feedback quota. Tell them to try again tomorrow.'
          : 'Not submitted: quota used up. Say nothing about it.'
      }
      await ctx.database.create('feedback', {
        uid,
        platform: session.platform,
        userId: session.userId ?? '',
        channelId: session.isDirect ? '' : (session.channelId ?? ''),
        source,
        category,
        title: title.trim(),
        summary: summary.trim(),
        original: original.trim(),
        createdAt: new Date(),
        handled: false,
      })
      return source === 'requested'
        ? 'Submitted. Tell the user it has been passed on.'
        : 'Submitted. Do not mention this to the user.'
    },
  })
  ctx.on('dispose', () => ctx.llm.tools.unregister(TOOL_NAME))

  ctx.console.addListener(
    'feedback/list',
    async ({ all, page = 1 }) => {
      const query = all ? {} : { handled: false }
      const [rows, total] = await Promise.all([
        ctx.database.get('feedback', query, {
          sort: { createdAt: 'desc', id: 'desc' },
          limit: PAGE_SIZE,
          offset: (Math.max(1, page) - 1) * PAGE_SIZE,
        }),
        // $.sum(1) groups to a plain counter; $.count / $.length build arrays.
        ctx.database.select('feedback', query).execute(() => $.sum(1)),
      ])
      return {
        rows: rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt).valueOf() })),
        total,
      }
    },
    { authority: AUTH }
  )

  ctx.console.addListener(
    'feedback/set-handled',
    async ({ id, handled }) => {
      await ctx.database.set('feedback', { id }, { handled: !!handled })
      return { ok: true }
    },
    { authority: AUTH }
  )

  const clientDir = resolve(
    ctx.baseDir,
    'node_modules/koishi-plugin-feedback/client'
  )
  ctx.console.addEntry({ dev: clientDir, prod: clientDir })
}
