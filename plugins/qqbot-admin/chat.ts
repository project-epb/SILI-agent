import { $, Context, Query, Time, h } from 'koishi'

import type { Console } from '@koishijs/console'

import type {} from '../../src/plugins/qqbot'
import { qqAvatar } from '../../src/plugins/qqbot/avatar'
import { GUARDED_PLATFORMS, isServed } from '../../src/plugins/qqbot/gate'
import type { ChannelMessage } from '../../src/services/channel-message-history'
import {
  type ChatProfile,
  createChatProfileLookup,
  knownName,
} from './chat-profiles'

const QQ_PLATFORM = 'qq'
const PRIVATE_PREFIX = 'private:'
const PAGE_SIZE = 60
const MAX_MESSAGE_LENGTH = 2000
const RECALL_WINDOW = 2 * Time.minute
const TEXT_FORMATS = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'del',
  'code',
  'pre',
  'p',
  'blockquote',
  'br',
])

interface ChatTarget {
  platform: string
  selfId: string
  channelId: string
}

interface Cursor {
  time: number
  id: string
}

interface Part {
  kind: 'text' | 'image' | 'audio' | 'video' | 'link' | 'mention'
  text?: string
  url?: string
  userId?: string
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
    if (type === 'at') {
      const userId = String(attrs.id ?? attrs.qq ?? '')
      const name = knownName(attrs.name, userId)
      return [
        {
          kind: 'mention',
          userId,
          text: name
            ? '@' + name
            : attrs.type === 'all'
              ? '@全体成员'
              : undefined,
        },
      ]
    }
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
            mention: '@成员',
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
  avatar?: string
  isSelf: boolean
  recalled: boolean
  recallUntil: number | null
  body: Part[]
  quote: { id: string; author: string; preview: string } | null
}

interface Conversation extends ChatTarget {
  id: string
  kind: 'group' | 'dm'
  name: string
  botName: string
  avatar?: string
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
    'qqbot-admin/chat-send'(
      payload: ChatTarget & {
        text: string
        quoteId?: string
        parseElements?: boolean
      }
    ): Promise<{
      ok: true
    }>
    'qqbot-admin/chat-recall'(
      payload: ChatTarget & { messageId: string }
    ): Promise<{
      ok: true
    }>
  }
}

function targetOf(target: ChatTarget) {
  const { platform = QQ_PLATFORM, selfId, channelId } = target ?? {}
  if (
    typeof platform !== 'string' ||
    !platform ||
    platform.length > 32 ||
    typeof selfId !== 'string' ||
    !selfId ||
    selfId.length > 64 ||
    typeof channelId !== 'string' ||
    !channelId ||
    channelId.length > 128
  ) {
    throw new Error('会话无效。')
  }
  return { platform, selfId, channelId }
}

const chatKey = ({ platform, selfId, channelId }: ChatTarget) =>
  JSON.stringify([platform, selfId, channelId])
const botKey = (platform: string, selfId: string) =>
  JSON.stringify([platform, selfId])

function messageIdOf(value: unknown) {
  if (typeof value !== 'string' || !value || value.length > 255)
    throw new Error('消息标识无效。')
  return value
}

async function validateMentions(
  ctx: Context,
  scope: ChatTarget,
  ids: string[]
) {
  if (!ids.length) return
  if (
    ids.some(
      (id) => typeof id !== 'string' || !id || id.length > 64 || id === 'all'
    )
  )
    throw new Error('艾特的用户标识无效。')
  const users = await ctx.database
    .select('channel_message', {
      ...scope,
      isSelf: { $ne: true },
      userId: [...new Set(ids)],
    })
    .groupBy('userId')
    .execute()
  const recorded = new Set(users.map((row) => row.userId))
  if (ids.some((id) => !recorded.has(id)))
    throw new Error('只能艾特本会话中有记录的发言者。')
}

function plainDraftElements(text: string) {
  const tokens = [...text.matchAll(/<at id="([^"]*)"\s*\/>/g)]
  if (!tokens.length) return [h.text(text)]
  const elements: h[] = []
  let cursor = 0
  for (const token of tokens) {
    if (token.index > cursor)
      elements.push(h.text(text.slice(cursor, token.index)))
    elements.push(h.at(h.unescape(token[1])))
    cursor = token.index + token[0].length
  }
  if (cursor < text.length) elements.push(h.text(text.slice(cursor)))
  return elements
}

function validateDraftElement({ type, attrs, children }: h): h {
  if (type === 'text') return h.text(String(attrs.content ?? ''))
  if (type === 'at') {
    if (attrs.type || typeof attrs.id !== 'string' || children.length)
      throw new Error('艾特请使用 <at id="…"/>。')
    return h.at(attrs.id)
  }
  if (type === 'markdown') {
    if (children.some((element) => element.type !== 'text'))
      throw new Error('请把艾特等元素放在 <markdown> 外面。')
    const markdown = children.length
      ? children.map((element) => element.attrs.content).join('')
      : typeof attrs.content === 'string'
        ? attrs.content
        : ''
    return h('markdown', h.text(markdown))
  }
  if (type === 'a') {
    const href = safeUrl(attrs.href)
    if (!href) throw new Error('链接需要有效的 HTTP(S) 地址。')
    return h('a', { href }, children.map(validateDraftElement))
  }
  if (TEXT_FORMATS.has(type)) return h(type, children.map(validateDraftElement))
  if (type === 'quote')
    throw new Error('<quote> 只能放在消息开头，且只能有一个。')
  throw new Error(`元素解析模式暂不支持 <${type}>。`)
}

function parsedDraft(text: string) {
  // Parsing without a context keeps template expressions literal.
  const parsed = h.parse(text)
  let quoteId: string | undefined
  if (parsed[0]?.type === 'quote') {
    const quote = parsed.shift()!
    if (quote.children.length) throw new Error('引用请使用 <quote id="…"/>。')
    quoteId = messageIdOf(quote.attrs.id)
  }
  const elements = parsed.map(validateDraftElement)
  if (!elements.length) throw new Error('请在引用后输入要发送的内容。')
  return { elements, quoteId }
}

export function applyChat(ctx: Context, authority: number) {
  // Koishi may resolve the console service through a second copy of the package.
  const console = ctx.console as unknown as Pick<
    Console,
    'addListener' | 'broadcast'
  >
  const auth = { authority }
  const lookupProfiles = createChatProfileLookup(ctx)
  const recalling = new Set<string>()
  const broadcastActivity = (
    scope: ChatTarget,
    time: Date,
    recalledMessageId?: string
  ) => {
    void console
      .broadcast(
        'qqbot-admin/chat-activity',
        { ...scope, time: time.getTime(), recalledMessageId },
        auth
      )
      .catch((error) =>
        ctx
          .logger('qqbot-admin')
          .warn('chat activity notification failed', error)
      )
  }
  ctx.on(
    'channel-message-recorded',
    ({ platform, selfId, channelId, time }) => {
      broadcastActivity({ platform, selfId, channelId }, time)
    }
  )

  console.addListener(
    'qqbot-admin/chats',
    async () => {
      const activity = await ctx.database
        .select('channel_message', { platform: { $ne: '' } })
        .groupBy(
          ['platform', 'selfId', 'channelId', 'channelName', 'channelType'],
          { lastAt: (row) => $.max(row.time) }
        )
        .orderBy('lastAt', 'desc')
        .execute()
      if (!activity.length) return []
      const botNames = new Map(
        ctx.bots.map(
          (bot) =>
            [botKey(bot.platform, bot.selfId), bot.user?.name ?? ''] as const
        )
      )
      const conversations = new Map<string, Conversation>()
      const groupIds = new Set<string>()
      const userIds = new Set<string>()
      for (const row of activity) {
        const key = chatKey(row)
        const existing = conversations.get(key)
        if (existing) {
          if (!existing.name && row.channelName) existing.name = row.channelName
          if (row.channelType === 'dm') existing.kind = 'dm'
          continue
        }
        const { platform, selfId, channelId } = row
        const hasPrivatePrefix = channelId.startsWith(PRIVATE_PREFIX)
        const direct = hasPrivatePrefix || row.channelType === 'dm'
        const id = hasPrivatePrefix
          ? channelId.slice(PRIVATE_PREFIX.length)
          : channelId
        conversations.set(key, {
          platform,
          selfId,
          channelId,
          id,
          kind: direct ? 'dm' : 'group',
          name: row.channelName ?? '',
          botName: botNames.get(botKey(platform, selfId)) ?? '',
          time: new Date(row.lastAt).getTime(),
        })
        if (platform === QQ_PLATFORM) (direct ? userIds : groupIds).add(id)
      }
      const [groups, users] = await Promise.all([
        groupIds.size
          ? ctx.database.get(
              'qqbot_channel',
              { platform: QQ_PLATFORM, id: [...groupIds] },
              ['selfId', 'id', 'name']
            )
          : [],
        userIds.size
          ? ctx.database.get(
              'qqbot_user',
              { platform: QQ_PLATFORM, id: [...userIds] },
              ['selfId', 'id', 'name', 'avatar']
            )
          : [],
      ])
      const groupNames = new Map<string, string>(
        groups.map(
          (row) => [JSON.stringify([row.selfId, row.id]), row.name] as const
        )
      )
      const accounts = new Map(
        users.map((row) => [JSON.stringify([row.selfId, row.id]), row] as const)
      )
      return [...conversations.values()].map((chat) => {
        if (chat.platform === QQ_PLATFORM) {
          const key = JSON.stringify([chat.selfId, chat.id])
          if (chat.kind === 'dm') {
            const account = accounts.get(key)
            chat.name = account?.name || chat.name
            chat.avatar = qqAvatar(account?.avatar)
          } else {
            chat.name = groupNames.get(key) || chat.name
          }
        }
        return chat
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
      const bodies = page.map((row) => bodyOf(row.content))
      const unknownMentions = new Set<string>()
      for (const body of bodies) {
        for (const part of body) {
          if (
            part.kind === 'mention' &&
            !part.text &&
            part.userId &&
            part.userId !== scope.selfId
          )
            unknownMentions.add(part.userId)
        }
      }
      const referenceIds = [
        ...new Set(page.map((row) => row.quoteId).filter(Boolean)),
      ]
      const [targets, profiles] = await Promise.all([
        referenceIds.length
          ? ctx.database.get(
              'channel_message',
              {
                ...scope,
                recalled: { $ne: true },
                $or: [{ messageId: referenceIds }, { refIdx: referenceIds }],
              },
              ['messageId', 'refIdx', 'userId', 'username', 'isSelf', 'content']
            )
          : [],
        lookupProfiles(scope, unknownMentions, page).catch((error) => {
          ctx.logger('qqbot-admin').debug('chat profile lookup failed', error)
          return new Map<string, ChatProfile>()
        }),
      ])
      const quotes = new Map<string, ChatMessage['quote']>()
      for (const row of targets) {
        const quote = {
          id: row.messageId,
          author:
            profiles.get(row.userId)?.groupName ||
            row.username ||
            (row.isSelf ? 'SILI' : '群友'),
          preview: quotePreview(row.content),
        }
        quotes.set(row.messageId, quote)
        if (row.refIdx) quotes.set(row.refIdx, quote)
      }
      return {
        hasOlder: rows.length > PAGE_SIZE,
        messages: page.map(
          (row, index): ChatMessage => ({
            id: row.messageId,
            time: row.time.getTime(),
            userId: row.userId,
            username:
              profiles.get(row.userId)?.groupName ||
              row.username ||
              profiles.get(row.userId)?.name ||
              '',
            avatar: profiles.get(row.userId)?.avatar,
            isSelf: row.isSelf,
            recalled: !!row.recalled,
            recallUntil:
              row.isSelf && !row.recalled
                ? row.time.getTime() + RECALL_WINDOW
                : null,
            body: bodies[index].map((part) => {
              const profile =
                part.kind === 'mention' && !part.text && part.userId
                  ? profiles.get(part.userId)
                  : undefined
              const name = profile?.groupName || profile?.name
              return name ? { ...part, text: '@' + name } : part
            }),
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
    'qqbot-admin/chat-recall',
    async (payload) => {
      const scope = targetOf(payload)
      const messageId = messageIdOf(payload.messageId)
      const key = JSON.stringify([
        scope.platform,
        scope.selfId,
        scope.channelId,
        messageId,
      ])
      if (recalling.has(key)) throw new Error('这条消息正在处理。')
      recalling.add(key)
      try {
        const query = { ...scope, messageId, isSelf: true }
        const [message] = await ctx.database.get('channel_message', query, [
          'time',
          'recalled',
        ])
        if (!message) throw new Error('只能操作本机器人发出的消息。')
        if (message.recalled) return { ok: true } as const
        const age = Date.now() - message.time.getTime()
        if (!Number.isFinite(age) || age < 0 || age >= RECALL_WINDOW)
          throw new Error('只能操作两分钟内发出的消息。')
        const bot = ctx.bots.find(
          (bot) =>
            bot.platform === scope.platform && bot.selfId === scope.selfId
        )
        if (!bot) throw new Error('该会话的机器人当前不可用。')
        try {
          await bot.deleteMessage(scope.channelId, messageId)
        } catch {
          throw new Error('平台未确认撤回或删除。')
        }
        try {
          await ctx.database.set('channel_message', query, {
            recalled: true,
            content: '',
            quoteId: '',
          })
        } catch (error) {
          ctx
            .logger('qqbot-admin')
            .warn('update recalled message history failed', error)
          throw new Error('平台已处理消息，本地历史更新失败。')
        }
        broadcastActivity(scope, message.time, messageId)
        return { ok: true } as const
      } finally {
        recalling.delete(key)
      }
    },
    auth
  )

  console.addListener(
    'qqbot-admin/chat-send',
    async (payload) => {
      const scope = targetOf(payload)
      const { platform, selfId, channelId } = scope
      const content =
        typeof payload.text === 'string' ? payload.text.trim() : ''
      if (!content || content.length > MAX_MESSAGE_LENGTH) {
        throw new Error('请输入 1 至 2000 个字符的消息。')
      }
      const bot = ctx.bots.find(
        (bot) => bot.platform === platform && bot.selfId === selfId
      )
      if (!bot) throw new Error('该会话的机器人当前不可用。')
      const [record] = await ctx.database.get('channel_message', scope, {
        fields: ['channelType'],
        sort: { time: 'desc', messageId: 'desc' },
        limit: 1,
      })
      if (!record) throw new Error('找不到该会话的聊天记录。')
      const hasPrivatePrefix = channelId.startsWith(PRIVATE_PREFIX)
      const direct = hasPrivatePrefix || record.channelType === 'dm'
      let userId = hasPrivatePrefix
        ? channelId.slice(PRIVATE_PREFIX.length)
        : ''
      if (direct && !userId && GUARDED_PLATFORMS.has(platform)) {
        const [incoming] = await ctx.database.get(
          'channel_message',
          { ...scope, isSelf: false },
          {
            fields: ['userId'],
            sort: { time: 'desc', messageId: 'desc' },
            limit: 1,
          }
        )
        userId = incoming?.userId ?? ''
      }
      if (!isServed({ ...scope, isDirect: direct, userId }, ctx.qqbot.state)) {
        throw new Error('此会话当前不可发送。')
      }
      if (platform === QQ_PLATFORM && !direct) {
        const [group] = await ctx.database.get(
          'qqbot_channel',
          { platform, selfId, id: channelId },
          ['allowProactive', 'removedAt', 'recvRejected']
        )
        if (!group || group.removedAt || group.recvRejected) {
          throw new Error('此群当前不可发送。')
        }
        if (!group.allowProactive) throw new Error('此群未允许机器人主动发送。')
      }
      const { elements, quoteId: inlineQuote } =
        payload.parseElements === true
          ? parsedDraft(content)
          : { elements: plainDraftElements(content), quoteId: undefined }
      await validateMentions(
        ctx,
        scope,
        h.select(elements, 'at').map((element) => element.attrs.id)
      )
      if (payload.quoteId !== undefined && inlineQuote !== undefined)
        throw new Error('编辑框已有引用，请移除其中一个引用。')
      const quoteId =
        payload.quoteId === undefined ? inlineQuote : payload.quoteId
      if (quoteId !== undefined) {
        const [quote] = await ctx.database.get(
          'channel_message',
          {
            ...scope,
            messageId: messageIdOf(quoteId),
            recalled: { $ne: true },
          },
          ['messageId', 'refIdx']
        )
        if (!quote) throw new Error('引用消息不可用，请取消引用或重新选择。')
        const id = GUARDED_PLATFORMS.has(platform)
          ? quote.refIdx || quote.messageId
          : quote.messageId
        elements.unshift(h.quote(id))
      }
      try {
        const sent =
          platform === QQ_PLATFORM && direct && userId
            ? await bot.sendPrivateMessage(userId, elements)
            : await bot.sendMessage(channelId, elements)
        if (!sent.length) throw new Error('No message ID returned.')
      } catch {
        throw new Error(
          '平台未确认发送成功。请先查看聊天记录，再决定是否重试。'
        )
      }
      return { ok: true } as const
    },
    auth
  )
}
