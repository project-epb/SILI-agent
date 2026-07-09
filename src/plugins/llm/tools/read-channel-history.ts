import type { Bot } from '@koishijs/core'

import type { ToolDefinition } from '../providers/_base'

import type { ToolHandler } from './types'

export const READ_CHANNEL_HISTORY_TOOL: ToolDefinition = {
  name: 'read_channel_history',
  description: [
    '查看**当前群聊** channel 的最近消息历史（只在群聊 / channel 里可用，私聊会拒绝）。',
    '',
    '**何时调**：',
    '- 用户在群里 @ 你问「你怎么看 / 大家刚才在聊啥」之类，但你的对话历史里没有上下文',
    '- 需要 catch up 一段刚才错过的群讨论',
    '- 群聊环境，用户问的与你看到的上下文不沾边，可能在讨论群内事宜',
    '',
    '**何时别调**：',
    '- 私聊场景（会报错）—— 你和当前用户的完整对话历史已经在 prompt 里',
    '- 闲聊/已经能直接回答的问题',
    '- 凑上下文 / 例行扫一遍（浪费 token）',
    '',
    '**约束**：仅能查当前 channel，不能跨群；NapCat 端单次最多约 30 条；分页用上次返回里的 `before_seq` 字段继续往前拉。',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      count: {
        type: 'integer',
        description: '拉取条数，1-30，默认 20',
        minimum: 1,
        maximum: 30,
      },
      before_seq: {
        type: 'integer',
        description:
          '分页用：只返回 message_seq 严格小于此值的消息（不传则取最新一批）',
      },
    },
    additionalProperties: false,
  },
}

export interface ReadChannelHistoryInput {
  count?: number
  before_seq?: number
}

interface SeenCacheEntry {
  maxSeq: number
  ts: number
}

/**
 * Per-(conversation, channel) memory of the newest message_seq the agent
 * has already received. Lets us trim already-shown messages from
 * subsequent calls so the agent doesn't burn tokens re-reading the same
 * window. Plain in-memory Map — lost on restart, which is fine.
 */
const SEEN_CACHE_TTL_MS = 5 * 60 * 1000

export interface OneBotSegment {
  type: string
  data?: Record<string, unknown>
}

export interface OneBotHistoryMessage {
  message_id?: number
  message_seq?: number
  time?: number
  sender?: {
    user_id?: number
    nickname?: string
    card?: string
    role?: string
  }
  message?: OneBotSegment[] | string
  group_id?: number
  group_name?: string
  self_id?: number
  post_type?: string
  message_sent_type?: string
}

const TZ = 'Asia/Shanghai'

function formatTime(unixSec: number | undefined): string {
  if (!unixSec || !Number.isFinite(unixSec) || unixSec <= 0) {
    return '(unknown time)'
  }
  return new Date(unixSec * 1000).toLocaleString('sv', { timeZone: TZ })
}

function pickDisplayName(sender: OneBotHistoryMessage['sender']): string {
  if (!sender) return '(unknown)'
  const card = sender.card?.trim()
  const nick = sender.nickname?.trim()
  return card || nick || `user_${sender.user_id ?? '?'}`
}

function escapeXmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return escapeXmlText(s).replace(/"/g, '&quot;')
}

function attr(name: string, val: unknown): string {
  if (val === undefined || val === null || val === '') return ''
  return ` ${name}="${escapeAttr(String(val))}"`
}

/**
 * Render a single OneBot segment into koishi h-element string form, matching
 * what live messages look like by the time they reach the model. We map the
 * common cases by hand and fall back to `<{type}/>` for unknown segment
 * types — model still gets a signal that something non-text was there
 * without seeing the raw OneBot blob.
 */
export function renderSegment(seg: OneBotSegment | null | undefined): string {
  if (!seg || typeof seg.type !== 'string') return ''
  const data = (seg.data ?? {}) as Record<string, any>
  switch (seg.type) {
    case 'text':
      return escapeXmlText(typeof data.text === 'string' ? data.text : '')
    case 'image':
      return `<img${attr('src', data.url ?? data.file)}${attr('summary', data.summary)}/>`
    case 'at': {
      const qq = data.qq ?? data.user_id
      if (qq === 'all') return '<at type="all"/>'
      return `<at${attr('id', qq)}${attr('name', data.name)}/>`
    }
    case 'reply':
      return `<quote${attr('id', data.id)}/>`
    case 'face':
      return `<face${attr('id', data.id)}/>`
    case 'mface':
      return `<mface${attr('id', data.emoji_id ?? data.id)}${attr('summary', data.summary)}/>`
    case 'video':
      return `<video${attr('src', data.url ?? data.file)}/>`
    case 'record':
      return `<audio${attr('src', data.url ?? data.file)}/>`
    case 'file':
      return `<file${attr('src', data.url ?? data.file)}${attr('name', data.file_name ?? data.name)}/>`
    case 'forward':
      return `<forward${attr('id', data.id)}/>`
    case 'json':
      return '<json/>'
    case 'xml':
      return '<xml/>'
    case 'rps':
    case 'dice':
      return `<${seg.type}/>`
    default:
      return `<${escapeXmlText(seg.type)}/>`
  }
}

function renderMessageBody(
  message: OneBotHistoryMessage['message']
): string {
  if (typeof message === 'string') {
    // raw_message-style CQ string — keep as-is, escape minimally for safety
    return escapeXmlText(message)
  }
  if (!Array.isArray(message)) return ''
  return message.map(renderSegment).join('')
}

export interface RenderedHistoryMeta {
  channelId: string
  channelName?: string
  countReturned: number
  countRequested: number
  earliestSeq?: number
  earliestTime?: number
  latestTime?: number
  selfId?: number
  /** Number of messages dropped because they were already shown to the agent in a prior call. */
  alreadySeenCount?: number
  /** The cached max seq used for trimming, if any. */
  previousMaxSeq?: number
}

export function buildHistoryHeader(meta: RenderedHistoryMeta): string {
  const lines: string[] = []
  const ch = meta.channelName
    ? `${meta.channelId} (${meta.channelName})`
    : meta.channelId
  lines.push(`Channel: ${ch}`)
  if (meta.countReturned > 0 && meta.earliestTime && meta.latestTime) {
    lines.push(
      `Time range: ${formatTime(meta.earliestTime)} ~ ${formatTime(meta.latestTime)}`
    )
  }
  lines.push(
    `Messages (oldest → newest, ${meta.countReturned} of ${meta.countRequested} requested):`
  )
  if (meta.alreadySeenCount && meta.alreadySeenCount > 0) {
    lines.push(
      `（已隐藏 ${meta.alreadySeenCount} 条你上次调用已经看过的消息（seq ≤ ${meta.previousMaxSeq}）。如需重看完整窗口，传 before_seq=${(meta.previousMaxSeq ?? 0) + 1}）`
    )
  }
  return lines.join('\n')
}

export function buildHistoryFooter(meta: RenderedHistoryMeta): string {
  if (meta.countReturned === 0 || meta.earliestSeq === undefined) return ''
  return `\n\n（如需更早的消息，下次调用传 before_seq=${meta.earliestSeq}）`
}

function isSelfMessage(m: OneBotHistoryMessage): boolean {
  return (
    m.post_type === 'message_sent' ||
    m.message_sent_type === 'self' ||
    (!!m.self_id && m.sender?.user_id === m.self_id)
  )
}

export function renderHistoryMessages(
  messages: OneBotHistoryMessage[]
): string[] {
  return messages.map((m) => {
    const time = formatTime(m.time)
    const name = pickDisplayName(m.sender)
    const uid = m.sender?.user_id ?? '?'
    const tags: string[] = []
    if (m.sender?.role && m.sender.role !== 'member') tags.push(m.sender.role)
    if (isSelfMessage(m)) tags.push('self')
    const tagStr = tags.length ? `, ${tags.join(',')}` : ''
    const body = renderMessageBody(m.message)
    return `[${time}] ${name} (${uid}${tagStr}): ${body}`
  })
}

export function renderHistoryPayload(
  messages: OneBotHistoryMessage[],
  meta: Omit<RenderedHistoryMeta, 'earliestSeq' | 'earliestTime' | 'latestTime' | 'countReturned'>
): string {
  if (messages.length === 0) {
    return buildHistoryHeader({ ...meta, countReturned: 0 })
  }
  const first = messages[0]
  const last = messages[messages.length - 1]
  const fullMeta: RenderedHistoryMeta = {
    ...meta,
    channelName: meta.channelName ?? first?.group_name,
    countReturned: messages.length,
    earliestSeq: first?.message_seq,
    earliestTime: first?.time,
    latestTime: last?.time,
  }
  const header = buildHistoryHeader(fullMeta)
  const lines = renderHistoryMessages(messages)
  const footer = buildHistoryFooter(fullMeta)
  return `${header}\n\n${lines.join('\n')}${footer}`
}

/** Pure helper: drop messages whose seq ≤ cachedMaxSeq. Returns the trimmed
 *  list and how many were trimmed. Used by the handler after cache hit. */
export function trimAlreadySeen(
  messages: OneBotHistoryMessage[],
  cachedMaxSeq: number
): { kept: OneBotHistoryMessage[]; trimmedCount: number } {
  if (!Number.isFinite(cachedMaxSeq)) {
    return { kept: messages, trimmedCount: 0 }
  }
  const kept = messages.filter(
    (m) => typeof m.message_seq === 'number' && m.message_seq > cachedMaxSeq
  )
  return { kept, trimmedCount: messages.length - kept.length }
}

export function buildReadChannelHistoryHandler(): ToolHandler {
  const seenCache = new Map<string, SeenCacheEntry>()

  return {
    definition: READ_CHANNEL_HISTORY_TOOL,
    async execute(args, { session, logger }) {
      if (session.platform !== 'onebot') {
        return `Error: read_channel_history 仅支持 onebot 平台（当前: ${session.platform}）`
      }
      if (!session.guildId) {
        return 'Error: 当前为私聊场景，read_channel_history 不适用。你和当前用户的完整对话历史已经在 prompt 里，直接基于已有内容回答即可。'
      }

      const input = (args ?? {}) as ReadChannelHistoryInput
      const requested =
        typeof input.count === 'number' && Number.isFinite(input.count)
          ? Math.floor(input.count)
          : 20
      const count = Math.min(30, Math.max(1, requested))

      const explicitBeforeSeq =
        typeof input.before_seq === 'number' &&
        Number.isFinite(input.before_seq) &&
        input.before_seq > 0

      const params: Record<string, unknown> = {
        group_id: Number(session.guildId),
        count,
        reverse_order: true,
      }
      // Anchor at user's triggering message_seq by default — NapCat's
      // get_group_msg_history walks backward from this cursor, so SILI's
      // own reply / status messages (higher seq) are naturally excluded
      // without time-based heuristics. Model can override via before_seq
      // for pagination.
      if (explicitBeforeSeq) {
        params.message_seq = Math.floor(input.before_seq!)
      } else if (session.messageId) {
        const anchor = Number(session.messageId)
        if (Number.isFinite(anchor) && anchor > 0) {
          params.message_seq = anchor
        }
      }

      const bot = session.bot as Bot & {
        internal?: { _request?: (action: string, params: any) => Promise<any> }
      }
      const internal = bot.internal
      if (!internal?._request) {
        return 'Error: onebot internal._request unavailable (adapter not initialized?)'
      }

      let res: any
      try {
        res = await internal._request('get_group_msg_history', params)
      } catch (e: any) {
        logger.warn('[read_channel_history] request failed:', e)
        return `Error: get_group_msg_history failed: ${e?.message ?? String(e)}`
      }

      const messages: OneBotHistoryMessage[] =
        res?.data?.messages ?? res?.messages ?? []
      if (!Array.isArray(messages) || messages.length === 0) {
        return `(channel ${session.guildId} 在指定范围内没有更多历史消息)`
      }

      // Cache trim: only when fetching the latest window (no explicit
      // before_seq pagination). Key by (conversation, channel) so different
      // agent sessions on the same channel keep separate views.
      const conversationId: string =
        (session.user as any)?.openai_last_conversation_id ?? ''
      const cacheKey =
        !explicitBeforeSeq && conversationId
          ? `${conversationId}:${session.guildId}`
          : ''
      const now = Date.now()
      let cachedMaxSeq: number | undefined
      if (cacheKey) {
        const cached = seenCache.get(cacheKey)
        if (cached && now - cached.ts < SEEN_CACHE_TTL_MS) {
          cachedMaxSeq = cached.maxSeq
        } else if (cached) {
          seenCache.delete(cacheKey)
        }
      }

      let toRender = messages
      let trimmedCount = 0
      if (cachedMaxSeq !== undefined) {
        const r = trimAlreadySeen(messages, cachedMaxSeq)
        toRender = r.kept
        trimmedCount = r.trimmedCount
      }

      if (cacheKey) {
        const newestSeq = messages[messages.length - 1]?.message_seq
        if (typeof newestSeq === 'number' && Number.isFinite(newestSeq)) {
          seenCache.set(cacheKey, { maxSeq: newestSeq, ts: now })
        }
      }

      if (toRender.length === 0) {
        return `(自上次调用 read_channel_history（看到 seq=${cachedMaxSeq}）以来没有新消息。如果想重看完整窗口，传 before_seq=${(cachedMaxSeq ?? 0) + 1}。)`
      }

      return renderHistoryPayload(toRender, {
        channelId: String(session.guildId),
        channelName: toRender[0]?.group_name ?? messages[0]?.group_name,
        countRequested: count,
        selfId: messages[0]?.self_id,
        alreadySeenCount: trimmedCount,
        previousMaxSeq: cachedMaxSeq,
      })
    },
  }
}
