import { Context, Schema, Service, Session, h } from 'koishi'

import { createHash } from 'node:crypto'

import { imageSize } from 'image-size'

import {
  StickerLabel,
  rewriteInbound,
  scanImages,
  sha1FromQQImageUrl,
} from './parse'
import {
  DEFAULT_HARVEST_SETTINGS,
  DailyUsage,
  HarvestSettings,
  STICKER_TYPES,
  Sticker,
  StickerSource,
  StickerStatus,
  stickerTypeLines,
} from './types'
import { VisionConfig, classifySticker } from './vision'

export * from './types'

declare module 'koishi' {
  interface Context {
    stickerPool: StickerPool
  }
}

const TZ = 'Asia/Shanghai'

/** Deterministic: it sits in the cached system prompt. */
const PERSONA_SECTION = `## 表情包
你可以发表情包：\`[koishi:emote tag="类型"]\` 会从这个类型里随机发一张。类型：
${stickerTypeLines()}

群友发的表情包在消息里显示为 \`[表情包 id="…" alt="画面" 用法="…"]\`；想跟着发同一张，用 \`[koishi:emote id="…"]\`。\`[QQ表情:名称]\` 是 QQ 自带的小表情。

用法：
- 表情是调味，不是回复。不要每句话都挂表情，不要连着发；一个话题里偶尔来一张就够了
- 被逗笑、无语、纯表态、接不上话的时候，可以只发一张表情、一个字都不写
- 遇到不好回答、不想正面接的话题，可以发一张卖萌的表情糊弄过去
- 表情都是你自己发的。有人问为什么发这张，按自己的语气答，不要说是系统发的
- \`sticker\` 指令是用模板生成文字表情包的，和发表情是两回事；想发表情就用上面的标记`
const today = () => new Date().toLocaleDateString('sv', { timeZone: TZ })
const EXT: Record<string, string> = {
  'image/gif': 'gif',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

export interface AddOptions {
  source: StickerSource
  tags?: string[]
  desc?: string
  usage?: string
}

export default class StickerPool extends Service {
  static inject = ['database', 'assets']

  static Config: Schema<StickerPool.Config> = Schema.object({
    vision: Schema.object({
      baseURL: Schema.string().required(),
      apiKey: Schema.string().role('secret').required(),
      model: Schema.string().default('deepseek-v4-flash'),
    }),
    maxFileBytes: Schema.natural().default(2 * 1024 * 1024),
    harvestMinSeen: Schema.natural().default(3),
    harvestMinUsers: Schema.natural().default(2),
  })

  /** Every row except candidates, by SHA1 — the inbound rewrite and harvest skip list. */
  private known = new Map<string, Sticker>()
  /** SHA1s being downloaded / classified right now. */
  private inFlight = new Set<string>()
  private log = this.ctx.logger('sticker-pool')

  constructor(
    ctx: Context,
    public config: StickerPool.Config
  ) {
    super(ctx, 'stickerPool')
    ctx.model.extend(
      'sticker',
      {
        id: 'unsigned',
        sha1: 'string(40)',
        source: 'string(16)',
        status: 'string(16)',
        tags: 'list',
        desc: 'string(255)',
        usage: 'string(255)',
        url: 'string(255)',
        mime: 'string(32)',
        width: 'unsigned',
        height: 'unsigned',
        animated: 'boolean',
        seenCount: 'unsigned',
        seenUsers: 'list',
        seenGroups: 'list',
        sentCount: 'unsigned',
        createdAt: 'timestamp',
        updatedAt: 'timestamp',
      },
      { autoInc: true, unique: ['sha1'] }
    )
    ctx.model.extend(
      'sticker_setting',
      { key: 'string(32)', value: 'json' },
      { primary: 'key' }
    )
    ctx.model.extend(
      'sticker_usage',
      { date: 'string(10)', stickers: 'unsigned', tokens: 'unsigned' },
      { primary: 'date' }
    )

    ctx.on('llm/build-system-prompt', (registry) => {
      registry.add('sticker', PERSONA_SECTION)
    })

    ctx.on('message', (session) => {
      if (session.isDirect || session.selfId === session.userId) return
      this.observe(session).catch((e) => this.log.warn('harvest failed:', e))
    })
  }

  protected async start() {
    const rows = await this.ctx.database.get('sticker', {
      status: { $ne: 'candidate' },
    })
    for (const row of rows) this.known.set(row.sha1, row)
    this.log.info('loaded %d stickers', rows.length)
  }

  // ---- reading -------------------------------------------------------------

  lookup(sha1: string): StickerLabel | undefined {
    const row = this.known.get(sha1)
    return row?.status === 'active' ? row : undefined
  }

  /** Content as the model should see it: stickers and QQ faces named. */
  rewriteInbound(content: string): string {
    return rewriteInbound(content, (sha1) => this.lookup(sha1))
  }

  /**
   * The image for a `<sticker id|tag>` element (produced by the LLM output
   * filter). Undefined for an unknown id or an empty type — callers drop it,
   * never send it as text.
   */
  resolve(attrs: { id?: string | number; tag?: string }): h | undefined {
    const row = attrs.id
      ? this.byId(Number(attrs.id))
      : this.pick(String(attrs.tag ?? ''))
    if (!row) {
      this.log.info('sticker not found: id=%s tag=%s', attrs.id, attrs.tag)
      return
    }
    row.sentCount++
    this.ctx.database
      .set('sticker', row.id, { sentCount: row.sentCount })
      .catch(() => {})
    return h('img', { src: row.url })
  }

  /** Random active sticker whose primary tag is `tag`. */
  pick(tag: string): Sticker | undefined {
    const pool = [...this.known.values()].filter(
      (s) => s.status === 'active' && s.tags[0] === tag
    )
    return pool[Math.floor(Math.random() * pool.length)]
  }

  private byId(id: number): Sticker | undefined {
    for (const row of this.known.values())
      if (row.id === id && row.status === 'active') return row
  }

  // ---- harvesting ----------------------------------------------------------

  private async observe(session: Session) {
    for (const img of scanImages(session.content ?? '')) {
      if (!img.stickerFlag || !img.sha1 || this.known.has(img.sha1)) continue
      const row = await this.recordSighting(
        img.sha1,
        session.userId!,
        session.channelId!
      )
      if (
        row.seenCount < this.config.harvestMinSeen &&
        row.seenUsers.length < this.config.harvestMinUsers
      )
        continue
      if (this.inFlight.has(img.sha1)) continue
      const settings = await this.getSettings()
      if (!settings.enabled) continue
      const usage = await this.getUsage()
      if (
        usage.stickers >= settings.dailyMaxStickers ||
        usage.tokens >= settings.dailyMaxTokens
      )
        continue
      this.inFlight.add(img.sha1)
      // the url expires within hours: download now, from this message
      this.harvest(img.sha1, img.url)
        .catch((e) => this.log.warn('harvest %s failed: %s', img.sha1, e))
        .finally(() => this.inFlight.delete(img.sha1!))
    }
  }

  private async recordSighting(
    sha1: string,
    userId: string,
    channelId: string
  ) {
    const [row] = await this.ctx.database.get('sticker', { sha1 })
    const now = new Date()
    if (!row) {
      const created = await this.ctx.database.create('sticker', {
        sha1,
        source: 'harvest',
        status: 'candidate',
        tags: [],
        desc: '',
        usage: '',
        url: '',
        mime: '',
        seenCount: 1,
        seenUsers: [userId],
        seenGroups: [channelId],
        sentCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      return created
    }
    const seenUsers = row.seenUsers.includes(userId)
      ? row.seenUsers
      : [...row.seenUsers, userId].slice(-20)
    const seenGroups = row.seenGroups.includes(channelId)
      ? row.seenGroups
      : [...row.seenGroups, channelId].slice(-20)
    const patch = {
      seenCount: row.seenCount + 1,
      seenUsers,
      seenGroups,
      updatedAt: now,
    }
    await this.ctx.database.set('sticker', row.id, patch)
    return { ...row, ...patch }
  }

  private async harvest(sha1: string, url: string) {
    const { buffer, mime } = await this.download(url)
    const verdict = await classifySticker(this.visionConfig, buffer, mime)
    await this.addUsage({
      tokens: verdict.tokens,
      stickers: verdict.isSticker ? 1 : 0,
    })
    const [row] = await this.ctx.database.get('sticker', { sha1 })
    if (!verdict.isSticker) {
      await this.save(row.id, { status: 'rejected' })
      this.log.info('rejected %s', sha1)
      return
    }
    const file = await this.store(buffer, mime, sha1)
    await this.save(row.id, {
      status: 'active',
      tags: verdict.tags,
      desc: verdict.desc,
      ...file,
    })
    this.log.info(
      'harvested %s: [%s] %s',
      sha1,
      verdict.tags.join('/'),
      verdict.desc
    )
  }

  private async download(url: string) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`download ${res.status}`)
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length > this.config.maxFileBytes)
      throw new Error(`file too large: ${buffer.length}`)
    return {
      buffer,
      mime: res.headers.get('content-type')?.split(';')[0] || 'image/png',
    }
  }

  // ---- writing -------------------------------------------------------------

  /**
   * Add a picture by hand (admin upload, import scripts). An existing SHA1 is
   * returned as is. Without tags/desc the vision model fills them in.
   */
  async add(
    buffer: Buffer,
    mime: string,
    options: AddOptions
  ): Promise<Sticker> {
    const sha1 = createHash('sha1').update(buffer).digest('hex')
    const [existing] = await this.ctx.database.get('sticker', { sha1 })
    if (existing && existing.status !== 'candidate') return existing
    let { tags, desc } = options
    if (!tags?.length || !desc) {
      const verdict = await classifySticker(this.visionConfig, buffer, mime, {
        forceSticker: true,
      })
      await this.addUsage({ tokens: verdict.tokens, stickers: 0 })
      tags = tags?.length ? tags : verdict.tags
      desc = desc || verdict.desc
    }
    const file = await this.store(buffer, mime, sha1)
    const now = new Date()
    const fields = {
      source: options.source,
      status: 'active' as StickerStatus,
      tags,
      desc,
      usage: options.usage ?? '',
      ...file,
      updatedAt: now,
    }
    if (existing) {
      await this.save(existing.id, fields)
      return this.known.get(sha1)!
    }
    const row = await this.ctx.database.create('sticker', {
      sha1,
      ...fields,
      seenCount: 0,
      seenUsers: [],
      seenGroups: [],
      sentCount: 0,
      createdAt: now,
    })
    this.known.set(sha1, row)
    return row
  }

  async update(
    id: number,
    patch: Partial<Pick<Sticker, 'tags' | 'desc' | 'usage' | 'status'>>
  ) {
    if (patch.status && !['active', 'disabled'].includes(patch.status))
      throw new Error('status must be active or disabled')
    if (
      patch.tags &&
      patch.tags.some((t) => !(STICKER_TYPES as readonly string[]).includes(t))
    )
      throw new Error('unknown tag')
    await this.save(id, { ...patch, updatedAt: new Date() })
  }

  private async save(id: number, patch: Partial<Sticker>) {
    await this.ctx.database.set('sticker', id, patch)
    const [row] = await this.ctx.database.get('sticker', id)
    if (row && row.status !== 'candidate') this.known.set(row.sha1, row)
  }

  private async store(buffer: Buffer, mime: string, sha1: string) {
    const ext = EXT[mime] ?? 'png'
    const url = await this.ctx.assets.upload(
      `data:${mime};base64,${buffer.toString('base64')}`,
      `sticker.${ext}`
    )
    let width = 0
    let height = 0
    try {
      ;({ width = 0, height = 0 } = imageSize(buffer))
    } catch {}
    return {
      url,
      mime,
      width,
      height,
      animated: mime === 'image/gif' && isAnimatedGif(buffer),
    }
  }

  private get visionConfig(): VisionConfig {
    return this.config.vision
  }

  // ---- settings & usage ----------------------------------------------------

  async getSettings(): Promise<HarvestSettings> {
    const [row] = await this.ctx.database.get('sticker_setting', 'harvest')
    return { ...DEFAULT_HARVEST_SETTINGS, ...row?.value }
  }

  async setSettings(patch: Partial<HarvestSettings>) {
    const value = { ...(await this.getSettings()), ...patch }
    await this.ctx.database.upsert('sticker_setting', [
      { key: 'harvest', value },
    ])
    return value
  }

  async getUsage(date = today()): Promise<DailyUsage> {
    const [row] = await this.ctx.database.get('sticker_usage', date)
    return row ?? { date, stickers: 0, tokens: 0 }
  }

  private async addUsage(delta: { tokens: number; stickers: number }) {
    const date = today()
    const current = await this.getUsage(date)
    await this.ctx.database.upsert('sticker_usage', [
      {
        date,
        stickers: current.stickers + delta.stickers,
        tokens: current.tokens + delta.tokens,
      },
    ])
  }

  /** Rows for the admin page. */
  list(filter: { status?: StickerStatus; source?: StickerSource } = {}) {
    const query: any = {}
    if (filter.status) query.status = filter.status
    if (filter.source) query.source = filter.source
    return this.ctx.database.get('sticker', query, { sort: { id: 'desc' } })
  }
}

/** A gif with more than one graphic control extension (0x21 0xF9), i.e. several frames. */
function isAnimatedGif(buffer: Buffer) {
  let frames = 0
  for (let i = 13; i < buffer.length - 1 && frames < 2; i++) {
    if (buffer[i] === 0x21 && buffer[i + 1] === 0xf9) frames++
  }
  return frames > 1
}

namespace StickerPool {
  export interface Config {
    vision: VisionConfig
    maxFileBytes: number
    harvestMinSeen: number
    harvestMinUsers: number
  }
}

export { sha1FromQQImageUrl }
