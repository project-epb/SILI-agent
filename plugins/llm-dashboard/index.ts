import { Context } from 'koishi'

import { resolve } from 'node:path'

import '@koishijs/console'

import { type UsageRow, aggregateStats } from './aggregate'

// 注：本文件在 tsconfig include 之外，IDE 若对下方事件名类型增强报噪音属已知非阻塞，运行时正常。
declare module '@koishijs/console' {
  interface Events {
    'llm-dashboard/stats'(payload: {
      range: number
    }): ReturnType<typeof aggregateStats>
  }
}

const DAY = 86_400_000
const ALLOWED_RANGES = new Set([7, 30, 90])

export const name = 'llm-dashboard'
export const inject = ['console', 'database']

export function apply(ctx: Context) {
  ctx.console.addListener(
    'llm-dashboard/stats',
    async ({ range }) => {
      const rangeDays = ALLOWED_RANGES.has(range) ? range : 30
      const now = Date.now()
      const since = now - 2 * rangeDays * DAY

      const rows = (await ctx.database.get(
        'openai_chat',
        { role: 'assistant', time: { $gte: since } },
        {
          fields: [
            'time',
            'model',
            'conversation_owner',
            'usage',
            'conversation_id',
          ],
        }
      )) as unknown as UsageRow[]

      const ownerIds = [...new Set(rows.map((r) => r.conversation_owner))]
      const users = ownerIds.length
        ? await ctx.database.get(
            'user',
            { id: ownerIds },
            { fields: ['id', 'name'] }
          )
        : []
      const nameMap = new Map(users.map((u) => [u.id, u.name]))
      const nameOf = (id: number) => nameMap.get(id) || `#${id}`

      return aggregateStats(rows, rangeDays, now, nameOf)
    },
    { authority: 3 }
  )

  // entry 必须走 node_modules 路径，否则被 console serveAssets 的 403 守卫拦（见 spec）。
  const clientDir = resolve(
    ctx.baseDir,
    'node_modules/koishi-plugin-llm-dashboard/client'
  )
  ctx.console.addEntry({ dev: clientDir, prod: clientDir })
}
