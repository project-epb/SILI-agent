/**
 * Emotion types a sticker can carry, each with what it is for. Shared by the
 * vision tagger and the persona prompt, so both read a type the same way.
 */
export const STICKER_TYPE_NOTES = {
  通用: '万能表情，没什么深意；对方说了句话、没什么好接的，出于礼节随手回一个',
  开心: '高兴、满足',
  大笑: '被逗笑、笑到不行',
  卖萌: '撒娇、装可爱',
  无语: '无话可说、无奈',
  疑惑: '没看懂、问号',
  惊讶: '震惊、难以置信',
  生气: '不满、发火（多半是玩笑）',
  委屈卖惨: '可怜、求安慰、自嘲',
  阴阳怪气: '反讽、嘲讽',
  赞同: '认同、点赞、感谢',
  拒绝: '不要、打住、别搞',
  晚安: '困了、睡觉、道别',
  其他: '以上都不贴切',
} as const

export type StickerType = keyof typeof STICKER_TYPE_NOTES

export const STICKER_TYPES = Object.keys(STICKER_TYPE_NOTES) as StickerType[]

export const stickerTypeLines = () =>
  STICKER_TYPES.map((t) => `- ${t}：${STICKER_TYPE_NOTES[t]}`).join('\n')

/**
 * - `candidate`: counted, not downloaded yet
 * - `active`: usable
 * - `disabled`: switched off by a human
 * - `rejected`: the vision model said it is not a sticker
 *
 * Rows are never deleted: a deleted row would let the same picture be
 * harvested again. `disabled` and `rejected` are terminal for harvesting.
 */
export type StickerStatus = 'candidate' | 'active' | 'disabled' | 'rejected'

export type StickerSource = 'upload' | 'harvest' | 'qface'

export interface Sticker {
  id: number
  /** SHA1 of the original file, hex. The sticker's identity. */
  sha1: string
  source: StickerSource
  status: StickerStatus
  /** Ordered by importance; random picks match the first one only. */
  tags: string[]
  /** What the picture shows. Never what it means. */
  desc: string
  /** How the group actually uses it. Written by humans only. */
  usage: string
  url: string
  mime: string
  width: number
  height: number
  animated: boolean
  seenCount: number
  seenUsers: string[]
  seenGroups: string[]
  sentCount: number
  createdAt: Date
  updatedAt: Date
}

export interface HarvestSettings {
  enabled: boolean
  dailyMaxStickers: number
  dailyMaxTokens: number
}

export const DEFAULT_HARVEST_SETTINGS: HarvestSettings = {
  enabled: false,
  dailyMaxStickers: 30,
  dailyMaxTokens: 50_000,
}

export interface DailyUsage {
  /** YYYY-MM-DD in Asia/Shanghai. */
  date: string
  stickers: number
  tokens: number
}

declare module 'koishi' {
  interface Tables {
    sticker: Sticker
    sticker_setting: { key: string; value: any }
    sticker_usage: DailyUsage
  }
}
