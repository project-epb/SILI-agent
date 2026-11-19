import { $, Context, Query } from 'koishi'

import { resolve } from 'node:path'

import '@koishijs/console'

import type {
  HarvestSettings,
  Sticker,
  StickerSource,
  StickerStatus,
} from '../../src/plugins/sticker-pool'
import { STICKER_TYPE_NOTES } from '../../src/plugins/sticker-pool/types'

/**
 * Console page for the sticker pool. All listeners require authority 4.
 * Rows are never deleted — only disabled — so a harvested picture cannot
 * come back on its next sighting.
 */
const AUTH = 4
const PAGE_SIZE = 60

export const name = 'sticker-admin'
export const inject = ['console', 'database', 'stickerPool']

interface StickerView {
  id: number
  url: string
  source: StickerSource
  status: StickerStatus
  tags: string[]
  desc: string
  usage: string
  owner: string
  name: string
  animated: boolean
  seenCount: number
  seenUsers: number
  seenGroups: number
  sentCount: number
  createdAt: number
}

interface ListArgs {
  status?: StickerStatus
  source?: StickerSource
  tag?: string
  q?: string
  page?: number
}

declare module '@koishijs/console' {
  interface Events {
    'sticker-admin/list'(args: ListArgs): { rows: StickerView[]; total: number }
    'sticker-admin/update'(args: {
      id: number
      tags?: string[]
      desc?: string
      usage?: string
      status?: 'active' | 'disabled'
    }): { ok: true }
    'sticker-admin/upload'(args: { dataUrl: string }): StickerView
    'sticker-admin/overview'(): {
      settings: HarvestSettings
      usage: { stickers: number; tokens: number }
      types: Record<string, string>
      counts: Record<string, number>
    }
    'sticker-admin/settings'(patch: Partial<HarvestSettings>): HarvestSettings
  }
}

const view = (s: Sticker): StickerView => ({
  id: s.id,
  url: s.url,
  source: s.source,
  status: s.status,
  tags: s.tags,
  desc: s.desc,
  usage: s.usage,
  owner: s.owner ?? '',
  name: s.name ?? '',
  animated: s.animated,
  seenCount: s.seenCount,
  seenUsers: s.seenUsers.length,
  seenGroups: s.seenGroups.length,
  sentCount: s.sentCount,
  createdAt: new Date(s.createdAt).valueOf(),
})

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function apply(ctx: Context) {
  ctx.console.addListener(
    'sticker-admin/list',
    async ({ status = 'active', source, tag, q, page = 1 }: ListArgs = {}) => {
      const filters: Query.Expr<Sticker>[] = [{ status }]
      if (source) filters.push({ source })
      if (tag) filters.push({ tags: { $el: tag } } as Query.Expr<Sticker>)
      if (q?.trim()) {
        const re = new RegExp(escapeRegExp(q.trim()), 'i')
        filters.push({ $or: [{ desc: { $regex: re } }, { usage: { $regex: re } }] })
      }
      const query = { $and: filters }
      const [rows, total] = await Promise.all([
        ctx.database.get('sticker', query, {
          sort: { id: 'desc' },
          offset: (Math.max(1, page) - 1) * PAGE_SIZE,
          limit: PAGE_SIZE,
        }),
        ctx.database.select('sticker', query).execute(() => $.sum(1)),
      ])
      return { rows: rows.map(view), total: total as number }
    },
    { authority: AUTH }
  )

  ctx.console.addListener(
    'sticker-admin/update',
    async ({ id, ...patch }) => {
      await ctx.stickerPool.update(id, patch)
      return { ok: true }
    },
    { authority: AUTH }
  )

  ctx.console.addListener(
    'sticker-admin/upload',
    async ({ dataUrl }) => {
      const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(dataUrl)
      if (!m) throw new Error('只接受图片')
      const row = await ctx.stickerPool.add(Buffer.from(m[2], 'base64'), m[1].toLowerCase(), {
        source: 'upload',
      })
      return view(row)
    },
    { authority: AUTH }
  )

  ctx.console.addListener(
    'sticker-admin/overview',
    async () => {
      const [settings, usage, grouped] = await Promise.all([
        ctx.stickerPool.getSettings(),
        ctx.stickerPool.getUsage(),
        ctx.database
          .select('sticker')
          .groupBy('status', { count: (row) => $.sum(1) })
          .execute(),
      ])
      return {
        settings,
        usage: { stickers: usage.stickers, tokens: usage.tokens },
        types: { ...STICKER_TYPE_NOTES },
        counts: Object.fromEntries(grouped.map((g: any) => [g.status, g.count])),
      }
    },
    { authority: AUTH }
  )

  ctx.console.addListener(
    'sticker-admin/settings',
    async (patch) => {
      const clean: Partial<HarvestSettings> = {}
      if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled
      for (const key of ['dailyMaxStickers', 'dailyMaxTokens'] as const) {
        const n = Number(patch[key])
        if (Number.isFinite(n) && n >= 0) clean[key] = Math.floor(n)
      }
      return ctx.stickerPool.setSettings(clean)
    },
    { authority: AUTH }
  )

  const clientDir = resolve(ctx.baseDir, 'node_modules/koishi-plugin-sticker-admin/client')
  ctx.console.addEntry({ dev: clientDir, prod: clientDir })
}
