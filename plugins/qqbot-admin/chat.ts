import { $, Context, Query, h } from 'koishi'

import type { Console } from '@koishijs/console'

import type {} from '../../src/plugins/qqbot'
import type { ChannelMessage } from '../../src/services/channel-message-history'

const PLATFORM = 'qq'
const PRIVATE_PREFIX = 'private:'
const PAGE_SIZE = 60
const MAX_MESSAGE_LENGTH = 2000

interface ChatTarget {
  selfId: string
  channelId: string
}

interface Cursor {
  time: number
  id: string
}

interface Part {
  kind: 'text' | 'image' | 'audio' | 'video' | 'link'
  text?: string
  url?: string
}

function safeUrl(value: unknown) {
  if (typeof value !== 'string') return
  try {
    const url = new URL(value)
    if (
      ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password
    ) {
      return url.href
    }
  } catch {
    return
  }
}

function parts(elements: h[]): Part[] {
  return elements.flatMap((element): Part[] => {
    const { type, attrs, children } = element
    if (type === 'quote') return []
    if (type === 'text')
      return [{ kind: 'text', text: String(attrs.content ?? '') }]
    if (type === 'br') return [{ kind: 'text', text: '\n' }]
    if (type === 'at')
      return [
        {
          kind: 'text',
          text:
            '@' + (attrs.name || (attrs.type === 'all' ? '全体成员' : '成员')),
        },
      ]
    if (
      type === 'img' ||
      type === 'image' ||
      type === 'audio' ||
      type === 'video'
    ) {
      const url = safeUrl(attrs.src ?? attrs.url)
      const kind = type === 'img' ? 'image' : type
      return url ? [{ kind, url }] : [{ kind: 'text', text: '[媒体不可用]' }]
    }
    if (type === 'a' || type === 'file') {
      const url = safeUrl(attrs.href ?? attrs.src ?? attrs.url)
      const text =
        children.map((child) => child.toString(true)).join('') ||
        attrs.name ||
        (type === 'file' ? '文件' : url)
      return url
        ? [{ kind: 'link', text, url }]
        : [{ kind: 'text', text: text || '[链接不可用]' }]
    }
    if (children.length) return parts(children)
    if (type === 'markdown' && typeof attrs.content === 'string')
      return [{ kind: 'text', text: attrs.content }]
    return [{ kind: 'text', text: '[消息元素]' }]
  })
}

const bodyOf = (content: string) => parts(h.parse(content ?? ''))

function quotePreview(content: string) {
  return bodyOf(content)
    .map(
      (part) =>
        part.text ||
        (
          {
            image: '[图片]',
            audio: '[语音]',
            video: '[视频]',
          } as Record<string, string>
        )[part.kind] ||
        ''
    )
    .join('')
    .trim()
    .slice(0, 160)
}

interface ChatMessage {
  id: string
  time: number
  userId: string
  username: string
  isSelf: boolean
  body: Part[]
  quote: { id: string; author: string; preview: string } | null
}

interface Conversation extends ChatTarget {
  id: string
  kind: 'group' | 'dm'
  name: string
  time: number
}

declare module '@koishijs/console' {
  interface Events {
    'qqbot-admin/chats'(): Promise<Conversation[]>
    'qqbot-admin/chat-history'(
      payload: ChatTarget & { before?: Cursor }
    ): Promise<{
      messages: ChatMessage[]
      hasOlder: boolean
    }>
    'qqbot-admin/chat-send'(payload: ChatTarget & { text: string }): Promise<{
      ok: true
    }>
  }
}

function targetOf(target: ChatTarget) {
  const { selfId, channelId } = target ?? {}
  if (
    typeof selfId !== 'string' ||
    !selfId ||
    selfId.length > 64 ||
    typeof channelId !== 'string' ||
    !channelId ||
    channelId.length > 128
  ) {
    throw new Error('会话无效。')
  }
  return { platform: PLATFORM, selfId, channelId }
}

export function applyChat(ctx: Context, authority: number) {
  // Koishi may resolve the console service through a second copy of the package.
  const console = ctx.console as unknown as Pick<
    Console,
    'addListener' | 'broadcast'
  >
  const auth = { authority }
  ctx.on(
    'channel-message-recorded',
    ({ platform, selfId, channelId, time }) => {
      if (platform !== PLATFORM) return
      void console
        .broadcast(
          'qqbot-admin/chat-activity',
          { selfId, channelId, time: time.getTime() },
          auth
        )
        .catch((error) =>
          ctx
            .logger('qqbot-admin')
            .warn('chat activity notification failed', error)
        )
    }
  )

  console.addListener(
    'qqbot-admin/chats',
    async () => {
      const activity = await ctx.database
        .select('channel_message', { platform: PLATFORM })
        .groupBy(['selfId', 'channelId'], { lastAt: (row) => $.max(row.time) })
        .orderBy('lastAt', 'desc')
        .execute()
      if (!activity.length) return []
      const groupIds = new Set<string>()
      const userIds = new Set<string>()
      for (const row of activity) {
        if (row.channelId.startsWith(PRIVATE_PREFIX))
          userIds.add(row.channelId.slice(PRIVATE_PREFIX.length))
        else groupIds.add(row.channelId)
      }
      const [groups, users] = await Promise.all([
        groupIds.size
          ? ctx.database.get(
              'qqbot_channel',
              { platform: PLATFORM, id: [...groupIds] },
              ['selfId', 'id', 'name']
            )
          : [],
        userIds.size
          ? ctx.database.get(
              'qqbot_user',
              { platform: PLATFORM, id: [...userIds] },
              ['selfId', 'id', 'name']
            )
          : [],
      ])
      const groupNames = new Map<string, string>(
        groups.map(
          (row) => [JSON.stringify([row.selfId, row.id]), row.name] as const
        )
      )
      const userNames = new Map<string, string>(
        users.map(
          (row) => [JSON.stringify([row.selfId, row.id]), row.name] as const
        )
      )
      return activity.map(({ selfId, channelId, lastAt }): Conversation => {
        const direct = channelId.startsWith(PRIVATE_PREFIX)
        const id = direct ? channelId.slice(PRIVATE_PREFIX.length) : channelId
        const name =
          (direct ? userNames : groupNames).get(JSON.stringify([selfId, id])) ??
          ''
        return {
          selfId,
          channelId,
          id,
          kind: direct ? 'dm' : 'group',
          name,
          time: new Date(lastAt).getTime(),
        }
      })
    },
    auth
  )

  console.addListener(
    'qqbot-admin/chat-history',
    async (payload) => {
      const scope = targetOf(payload)
      const query: Query.Expr<ChannelMessage> = { ...scope }
      if (payload.before) {
        const { id, time } = payload.before
        const date = new Date(time)
        if (
          typeof time !== 'number' ||
          !Number.isFinite(date.getTime()) ||
          typeof id !== 'string' ||
          !id ||
          id.length > 255
        )
          throw new Error('历史位置无效。')
        query.$or = [
          { time: { $lt: date } },
          { time: date, messageId: { $lt: id } },
        ]
      }
      const rows = await ctx.database.get('channel_message', query, {
        sort: { time: 'desc', messageId: 'desc' },
        limit: PAGE_SIZE + 1,
      })
      const page = rows.slice(0, PAGE_SIZE).reverse()
      const referenceIds = [
        ...new Set(page.map((row) => row.quoteId).filter(Boolean)),
      ]
      const targets = referenceIds.length
        ? await ctx.database.get(
            'channel_message',
            {
              ...scope,
              $or: [{ messageId: referenceIds }, { refIdx: referenceIds }],
            },
            ['messageId', 'refIdx', 'username', 'isSelf', 'content']
          )
        : []
      const quotes = new Map<string, ChatMessage['quote']>()
      for (const row of targets) {
        const quote = {
          id: row.messageId,
          author: row.username || (row.isSelf ? 'SILI' : '群友'),
          preview: quotePreview(row.content),
        }
        quotes.set(row.messageId, quote)
        if (row.refIdx) quotes.set(row.refIdx, quote)
      }
      return {
        hasOlder: rows.length > PAGE_SIZE,
        messages: page.map(
          (row): ChatMessage => ({
            id: row.messageId,
            time: row.time.getTime(),
            userId: row.userId,
            username: row.username,
            isSelf: row.isSelf,
            body: bodyOf(row.content),
            quote: row.quoteId
              ? (quotes.get(row.quoteId) ?? { id: '', author: '', preview: '' })
              : null,
          })
        ),
      }
    },
    auth
  )

  console.addListener(
    'qqbot-admin/chat-send',
    async (payload) => {
      const { selfId, channelId } = targetOf(payload)
      const content =
        typeof payload.text === 'string' ? payload.text.trim() : ''
      if (!content || content.length > MAX_MESSAGE_LENGTH) {
        throw new Error('请输入 1 至 2000 个字符的消息。')
      }
      const bot = ctx.bots.find(
        (bot) => bot.platform === PLATFORM && bot.selfId === selfId
      )
      if (!bot) throw new Error('QQ 机器人当前不可用。')
      const direct = channelId.startsWith(PRIVATE_PREFIX)
      const userId = channelId.slice(PRIVATE_PREFIX.length)
      if (direct) {
        if (!ctx.qqbot.state.isDmAllowed(PLATFORM, selfId, userId))
          throw new Error('此私聊未激活。')
      } else {
        const [group] = await ctx.database.get(
          'qqbot_channel',
          { platform: PLATFORM, selfId, id: channelId },
          ['allowProactive', 'removedAt', 'recvRejected']
        )
        if (
          !ctx.qqbot.state.isGroupActive(PLATFORM, selfId, channelId) ||
          !group ||
          group.removedAt ||
          group.recvRejected
        ) {
          throw new Error('此群当前不可发送。')
        }
        if (!group.allowProactive) throw new Error('此群未允许机器人主动发送。')
      }
      const text = h.text(content)
      try {
        const sent = direct
          ? await bot.sendPrivateMessage(userId, text)
          : await bot.sendMessage(channelId, text)
        if (!sent.length) throw new Error('No message ID returned.')
      } catch {
        throw new Error('QQ 未确认发送成功。请先查看聊天记录，再决定是否重试。')
      }
      return { ok: true } as const
    },
    auth
  )
}
