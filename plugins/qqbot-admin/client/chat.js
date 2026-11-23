import { icons, receive, send } from '../client.js'
import {
  computed,
  defineComponent,
  h,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  resolveComponent,
  watch,
} from '../vue.js'
import { ChatMembers, ChatSettings } from './chat-settings.js'
import { HoldSend } from './hold-send.js'

const subscriptions = new Set()
receive('qqbot-admin/chat-activity', (body) => {
  for (const onActivity of subscriptions) onActivity(body)
})

const keyOf = ({ platform, selfId, channelId }) =>
  JSON.stringify([platform, selfId, channelId])
const platformLabels = new Map([
  ['qq', 'QQ'],
  ['qqguild', 'QQ 频道'],
  ['discord', 'Discord'],
  ['kook', 'KOOK'],
  ['lark', '飞书'],
  ['dingtalk', '钉钉'],
  ['minecraft', 'Minecraft'],
  ['onebot', 'OneBot'],
])
const platformName = (platform) => platformLabels.get(platform) || platform
const kindName = (chat) =>
  chat.kind === 'dm' ? '私聊' : chat.platform === 'qq' ? '群聊' : '频道'
const descriptionOf = (chat) =>
  `${platformName(chat.platform)} · ${kindName(chat)}`
const recallLabel = (chat) =>
  chat.platform === 'qq' || chat.platform === 'qqguild' ? '撤回' : '删除'
const nameOf = (chat) => chat.name || `${kindName(chat)} · ${chat.id.slice(-8)}`
const clock = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})
const date = new Intl.DateTimeFormat('zh-CN', {
  month: 'long',
  day: 'numeric',
  weekday: 'short',
})
const dayOf = (time) => new Date(time).toDateString()
const timeOf = (time) =>
  dayOf(time) === dayOf(Date.now()) ? clock.format(time) : date.format(time)

const GROUP_GAP = 5 * 60 * 1000
const hueOf = (id) =>
  ['teal', 'blue', 'amber', 'rose'][
    String(id)
      .split('')
      .reduce((sum, c) => sum + c.charCodeAt(0), 0) % 4
  ]
// Telegram-style runs: consecutive messages from one sender on the same day.
const sameRun = (a, b) =>
  !!a &&
  !!b &&
  a.isSelf === b.isSelf &&
  a.userId === b.userId &&
  dayOf(a.time) === dayOf(b.time) &&
  Math.abs(b.time - a.time) < GROUP_GAP

const roleNames = { owner: '群主', admin: '管理员' }
const touchOnly = () => window.matchMedia('(hover: none)').matches

function avatar(name, id, onOpen, src) {
  const hue = hueOf(id)
  return h(
    onOpen ? 'button' : 'span',
    {
      class: ['qc-avatar', `is-${hue}`, onOpen && 'qc-avatar-button'],
      ...(onOpen
        ? {
            type: 'button',
            title: name,
            'aria-label': `${name} 的消息操作`,
            'aria-haspopup': 'menu',
            onClick: onOpen,
          }
        : { 'aria-hidden': 'true' }),
    },
    [
      [...name.trim()][0] || '·',
      src
        ? h('img', {
            key: src,
            src,
            alt: '',
            loading: 'lazy',
            referrerpolicy: 'no-referrer',
            onError: (event) => {
              event.currentTarget.hidden = true
            },
          })
        : null,
    ]
  )
}

function contentPart(part, index, selfId, ownName) {
  switch (part.kind) {
    case 'image':
      return h('img', {
        key: index,
        src: part.url,
        class: 'qc-media',
        loading: 'lazy',
        alt: '聊天图片',
        referrerpolicy: 'no-referrer',
      })
    case 'audio':
    case 'video':
      return h(part.kind, {
        key: index,
        src: part.url,
        class: 'qc-media',
        controls: true,
        preload: 'none',
      })
    case 'link':
      return h(
        'a',
        {
          key: index,
          href: part.url,
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        part.text
      )
    case 'mention': {
      const self = part.userId === selfId
      return h(
        'span',
        {
          key: index,
          class: ['qc-mention', self && 'is-self'],
        },
        part.text || (self ? `@${ownName}` : '@成员')
      )
    }
    default:
      return part.text
  }
}

function sortMessages(messages) {
  return [...messages.values()].sort(
    (a, b) => a.time - b.time || (a.id < b.id ? -1 : Number(a.id > b.id))
  )
}

function createChatPage(Features) {
  return defineComponent({
    setup() {
      const chats = ref([])
      const selected = ref(null)
      const filter = ref('')
      const platformFilter = ref('')
      const messages = ref([])
      const hasOlder = ref(false)
      const loadingChats = ref(true)
      const loading = ref(false)
      const chatError = ref('')
      const error = ref('')
      const menu = ref(false)
      const panel = ref(null)
      const scroller = ref(null)
      const newMessages = ref(false)
      const drafts = ref({})
      const replies = ref({})
      const clockNow = ref(Date.now())
      const composer = ref(null)
      const recallState = ref(null)
      const actionMenu = ref(null)
      const root = ref(null)
      const recalledIds = new Set()
      const nodes = new Map()
      const activity = new Map()
      let generation = 0
      let listVersion = 0
      let latestTimer
      let listTimer
      let poll
      let tick
      let mounted = true

      const current = computed(() =>
        chats.value.find((chat) => keyOf(chat) === selected.value)
      )
      const ownName = computed(
        () =>
          current.value?.botName ||
          messages.value.findLast((row) => row.isSelf && row.username)
            ?.username ||
          '本机器人'
      )
      const messageIds = computed(
        () => new Set(messages.value.map((row) => row.id))
      )
      const platforms = computed(() =>
        [...new Set(chats.value.map((chat) => chat.platform))].sort((a, b) =>
          platformName(a).localeCompare(platformName(b))
        )
      )
      const filtered = computed(() => {
        const q = filter.value.trim().toLowerCase()
        return chats.value.filter(
          (chat) =>
            (!platformFilter.value || chat.platform === platformFilter.value) &&
            (!q ||
              nameOf(chat).toLowerCase().includes(q) ||
              chat.id.toLowerCase().includes(q))
        )
      })

      async function refreshChats() {
        const version = ++listVersion
        if (listTimer) {
          clearTimeout(listTimer)
          listTimer = undefined
        }
        try {
          const rows = await send('qqbot-admin/chats')
          if (!mounted || version !== listVersion) return
          const byKey = new Map(chats.value.map((chat) => [keyOf(chat), chat]))
          chats.value = rows
            .map((row) => {
              const key = keyOf(row)
              const latest = Math.max(
                row.time,
                activity.get(key) ?? 0,
                byKey.get(key)?.time ?? 0
              )
              activity.delete(key)
              return { ...row, time: latest }
            })
            .sort((a, b) => b.time - a.time)
          chatError.value = ''
        } catch (cause) {
          if (version === listVersion)
            chatError.value = String(cause?.message ?? cause)
        } finally {
          if (version === listVersion) loadingChats.value = false
        }
      }

      const nearBottom = () =>
        !scroller.value ||
        scroller.value.scrollHeight -
          scroller.value.scrollTop -
          scroller.value.clientHeight <
          80

      function bottom() {
        if (scroller.value)
          scroller.value.scrollTop = scroller.value.scrollHeight
        newMessages.value = false
      }

      async function history({ older = false, initial = false } = {}) {
        const chat = current.value
        if (!chat) return
        if (loading.value) {
          if (!older && !initial) scheduleHistory()
          return
        }
        const token = generation
        loading.value = true
        error.value = ''
        const oldest = messages.value[0]
        const before =
          older && oldest ? { id: oldest.id, time: oldest.time } : undefined
        try {
          const result = await send('qqbot-admin/chat-history', {
            platform: chat.platform,
            selfId: chat.selfId,
            channelId: chat.channelId,
            before,
          })
          if (token !== generation || !mounted) return
          const atBottom = nearBottom()
          const oldHeight = scroller.value?.scrollHeight ?? 0
          const oldTop = scroller.value?.scrollTop ?? 0
          const byId = new Map(messages.value.map((row) => [row.id, row]))
          const fresh = result.messages.some((row) => !byId.has(row.id))
          const previousNewest = messages.value.at(-1)
          const oldestInResult = result.messages[0]
          const missedPage =
            !older &&
            previousNewest &&
            oldestInResult &&
            oldestInResult.time >= previousNewest.time &&
            !result.messages.some((row) => row.id === previousNewest.id)
          if (missedPage && !atBottom) {
            newMessages.value = true
            return
          }
          if (missedPage) byId.clear()
          for (const row of result.messages) {
            if (row.recalled) recalledIds.add(row.id)
            byId.set(row.id, row)
          }
          const reply = replies.value[selected.value]
          if (reply && recalledIds.has(reply.id)) reply.recalled = true
          messages.value = sortMessages(byId).map(withRecall)
          if (older || initial || !oldest || missedPage)
            hasOlder.value = result.hasOlder
          await nextTick()
          if (token !== generation || !scroller.value) return
          if (older)
            scroller.value.scrollTop =
              oldTop + scroller.value.scrollHeight - oldHeight
          else if (initial || atBottom) bottom()
          else if (fresh) newMessages.value = true
        } catch (cause) {
          if (token === generation)
            error.value = String(cause?.message ?? cause)
        } finally {
          if (token === generation) loading.value = false
        }
      }

      function scheduleHistory() {
        if (latestTimer || !mounted) return
        latestTimer = setTimeout(() => {
          latestTimer = undefined
          void history()
        }, 250)
      }

      function open(chat) {
        const key = chat ? keyOf(chat) : null
        if (key === selected.value) return
        generation++
        clearTimeout(latestTimer)
        latestTimer = undefined
        selected.value = key
        loading.value = false
        hasOlder.value = false
        messages.value = []
        error.value = ''
        menu.value = false
        panel.value = null
        recallState.value = null
        actionMenu.value = null
        newMessages.value = false
        nodes.clear()
        recalledIds.clear()
        if (chat) void history({ initial: true })
      }

      function onActivity(event) {
        const key = keyOf(event)
        const chat = chats.value.find((row) => keyOf(row) === key)
        if (chat) {
          if (chat.time < event.time) {
            chat.time = event.time
            chats.value.sort((a, b) => b.time - a.time)
          }
        } else {
          activity.set(key, Math.max(activity.get(key) ?? 0, event.time))
          listTimer ??= setTimeout(refreshChats, 250)
        }
        if (event.recalledMessageId) markRecalled(key, event.recalledMessageId)
        if (selected.value === key) scheduleHistory()
      }

      function resync() {
        if (document.hidden) return
        void refreshChats()
        if (current.value) scheduleHistory()
      }

      function updateRecallClock() {
        clearTimeout(tick)
        const now = Date.now()
        clockNow.value = now
        let next = Infinity
        for (const row of messages.value) {
          if (row.recallUntil > now) next = Math.min(next, row.recallUntil)
        }
        if (Number.isFinite(next))
          tick = setTimeout(updateRecallClock, next - now)
      }

      watch(messages, updateRecallClock)

      onMounted(() => {
        subscriptions.add(onActivity)
        document.addEventListener('visibilitychange', resync)
        poll = setInterval(resync, 20000)
        void refreshChats()
      })
      onUnmounted(() => {
        mounted = false
        subscriptions.delete(onActivity)
        document.removeEventListener('visibilitychange', resync)
        clearInterval(poll)
        clearTimeout(tick)
        clearTimeout(latestTimer)
        clearTimeout(listTimer)
      })

      // `parent` is the panel the header back arrow returns to; without one it closes the panel.
      function showPanel(kind, target, parent) {
        menu.value = false
        panel.value = { kind, target, parent }
      }

      function showUser(chat, user, parent) {
        if (!user.userId) return
        showPanel(
          'settings',
          {
            selfId: chat.selfId,
            id: user.userId,
            kind: 'dm',
            name: user.userName || user.username,
          },
          parent
        )
      }

      function withRecall(row) {
        if (recalledIds.has(row.id))
          return {
            ...row,
            recalled: true,
            recallUntil: null,
            body: [],
            quote: null,
          }
        if (row.quote?.id && recalledIds.has(row.quote.id))
          return { ...row, quote: { id: '' } }
        return row
      }

      function markRecalled(key, id) {
        const reply = replies.value[key]
        if (reply?.id === id) reply.recalled = true
        if (selected.value !== key) return
        recalledIds.add(id)
        messages.value = messages.value.map(withRecall)
      }

      function selectReply(chat, row, name) {
        const preview = row.body
          .map((part) => part.text || '')
          .join('')
          .trim()
          .slice(0, 150)
        replies.value[keyOf(chat)] = {
          id: row.id,
          author: name,
          preview: preview || '消息',
        }
        void nextTick(() => composer.value?.focus())
      }

      async function recall(chat, row) {
        if (
          recallState.value?.busy ||
          row.recalled ||
          row.recallUntil <= Date.now()
        )
          return
        const action = recallLabel(chat)
        if (!window.confirm(`${action}这条机器人消息？`)) return
        const { platform, selfId, channelId } = chat
        const key = keyOf(chat)
        const token = generation
        recallState.value = { id: row.id, busy: true }
        try {
          await send('qqbot-admin/chat-recall', {
            platform,
            selfId,
            channelId,
            messageId: row.id,
          })
          if (mounted) markRecalled(key, row.id)
          if (generation === token) recallState.value = null
        } catch (cause) {
          if (generation === token)
            recallState.value = {
              id: row.id,
              error: String(cause?.message ?? cause),
            }
        }
      }

      // Anchored to the tap point (or the trigger for keyboard clicks), flipped to stay inside the root.
      function openMenu(event, row) {
        const box = root.value?.getBoundingClientRect()
        if (!box) return
        const trigger = event.currentTarget.getBoundingClientRect()
        const x = event.detail ? event.clientX : trigger.left
        const y = event.detail ? event.clientY : trigger.bottom
        const left = Math.max(8, Math.min(x - box.left, box.width - 188))
        const below = y - box.top < box.height - 200
        actionMenu.value = {
          id: row.id,
          left,
          ...(below
            ? { top: y - box.top + 4 }
            : { bottom: box.bottom - y + 4 }),
        }
      }

      function renderActionMenu(chat) {
        const menuState = actionMenu.value
        const row =
          menuState && messages.value.find((item) => item.id === menuState.id)
        if (!row) return null
        const name = displayName(chat, row)
        const close = (action) => () => {
          actionMenu.value = null
          action()
        }
        const items = [
          !row.recalled && ['引用', () => selectReply(chat, row, name)],
          chat.kind === 'group' &&
            !row.isSelf &&
            row.userId && [
              `艾特 ${name}`,
              () => composer.value?.insertMention(row.userId),
            ],
          chat.kind === 'group' &&
            !row.isSelf &&
            chat.platform === 'qq' &&
            row.userId && ['成员配置', () => showUser(chat, row)],
          !row.recalled &&
            row.recallUntil > clockNow.value && [
              recallLabel(chat),
              () => recall(chat, row),
              true,
            ],
        ].filter(Boolean)
        return [
          h('div', {
            class: 'qc-menu-backdrop',
            onClick: () => (actionMenu.value = null),
            onContextmenu: (event) => {
              event.preventDefault()
              actionMenu.value = null
            },
          }),
          h(
            'div',
            {
              class: 'qc-action-menu',
              role: 'menu',
              style: {
                left: `${menuState.left}px`,
                top: menuState.top != null ? `${menuState.top}px` : undefined,
                bottom:
                  menuState.bottom != null
                    ? `${menuState.bottom}px`
                    : undefined,
              },
              onKeydown: (event) => {
                if (event.key === 'Escape') actionMenu.value = null
              },
            },
            items.length
              ? items.map(([label, action, danger]) =>
                  h(
                    'button',
                    {
                      type: 'button',
                      role: 'menuitem',
                      class: danger && 'is-danger',
                      onClick: close(action),
                    },
                    label
                  )
                )
              : h('span', { class: 'qc-action-empty' }, '没有可用操作')
          ),
        ]
      }

      function displayName(chat, row) {
        return (
          row.username ||
          (row.isSelf
            ? ownName.value
            : chat.kind === 'dm'
              ? nameOf(chat)
              : '群友')
        )
      }

      function messageActions(chat, row, name) {
        if (row.recalled) return null
        return h('span', { class: 'qc-message-actions' }, [
          h(
            'button',
            {
              type: 'button',
              onClick: () => selectReply(chat, row, name),
            },
            '引用'
          ),
          row.recallUntil > clockNow.value
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'qc-recall',
                  disabled: !!recallState.value?.busy,
                  onClick: () => recall(chat, row),
                },
                recallState.value?.id === row.id && recallState.value.busy
                  ? '处理中…'
                  : recallLabel(chat)
              )
            : null,
        ])
      }

      function jumpTo(id) {
        const node = nodes.get(id)
        if (!node) return
        node.scrollIntoView({ block: 'center', behavior: 'smooth' })
        node.classList.remove('is-flash')
        void node.offsetWidth
        node.classList.add('is-flash')
      }

      function renderMessage(chat, row, index) {
        const name = displayName(chat, row)
        const previous = messages.value[index - 1]
        const next = messages.value[index + 1]
        const newDay = !previous || dayOf(row.time) !== dayOf(previous.time)
        const head = !sameRun(previous, row)
        const tail = !sameRun(row, next)
        const author = chat.kind === 'group' && !row.isSelf
        const editableAuthor = author && chat.platform === 'qq'
        const quote = row.quote
        const quoteContent = quote?.id
          ? [h('strong', quote.author), h('span', quote.preview || '消息')]
          : '引用消息不可用'
        const quoteVisible = quote?.id && messageIds.value.has(quote.id)
        const meta = h('span', { class: 'qc-meta' }, [
          h(
            'time',
            {
              datetime: new Date(row.time).toISOString(),
              title: new Date(row.time).toLocaleString('zh-CN'),
            },
            clock.format(row.time)
          ),
        ])
        const actions = messageActions(chat, row, name)
        const roleTag = author && roleNames[row.role]
        const bubble = h(
          'div',
          {
            class: 'qc-bubble',
            // Touch screens have no hover actions: tapping the bubble opens the menu instead.
            onClick: (event) => {
              if (
                touchOnly() &&
                !event.target.closest('a, button, img, audio, video')
              )
                openMenu(event, row)
            },
          },
          [
            author && head
              ? h('div', { class: 'qc-author-line' }, [
                  h(
                    editableAuthor ? 'button' : 'span',
                    {
                      class: ['qc-author', `is-${hueOf(row.userId)}`],
                      ...(editableAuthor
                        ? {
                            type: 'button',
                            onClick: () => showUser(chat, row),
                            disabled: !row.userId,
                          }
                        : {}),
                    },
                    name
                  ),
                  row.isBot || roleTag
                    ? h('span', { class: 'qc-member-tags' }, [
                        row.isBot
                          ? h('small', { class: 'qc-member-tag' }, '机器人')
                          : null,
                        roleTag
                          ? h(
                              'small',
                              { class: ['qc-member-tag', `is-${row.role}`] },
                              roleTag
                            )
                          : null,
                      ])
                    : null,
                ])
              : null,
            row.isSelf && head && chat.kind === 'group'
              ? h('div', { class: 'qc-self-author' }, name)
              : null,
            quote
              ? h(
                  quoteVisible ? 'button' : 'div',
                  {
                    class: 'qc-quote',
                    type: quoteVisible ? 'button' : undefined,
                    onClick: quoteVisible ? () => jumpTo(quote.id) : undefined,
                  },
                  quoteContent
                )
              : null,
            h('div', { class: 'qc-body' }, [
              row.recalled
                ? h('em', { class: 'qc-recalled' }, `已${recallLabel(chat)}`)
                : row.body.length
                  ? row.body.map((part, index) =>
                      contentPart(part, index, chat.selfId, ownName.value)
                    )
                  : '[消息内容不可用]',
              meta,
            ]),
            recallState.value?.id === row.id && recallState.value.error
              ? h(
                  'p',
                  { class: 'qc-error', role: 'alert' },
                  recallState.value.error
                )
              : null,
          ]
        )
        return [
          newDay ? h('div', { class: 'qc-date' }, date.format(row.time)) : null,
          h(
            'div',
            {
              class: ['qc-message', row.isSelf && 'is-own', tail && 'is-tail'],
              ref: (node) =>
                node ? nodes.set(row.id, node) : nodes.delete(row.id),
            },
            row.isSelf
              ? [actions, bubble]
              : [
                  !author
                    ? null
                    : tail
                      ? avatar(
                          name,
                          row.userId,
                          (event) => openMenu(event, row),
                          row.avatar
                        )
                      : h('span', {
                          class: 'qc-avatar-gap',
                          'aria-hidden': 'true',
                        }),
                  bubble,
                  actions,
                ]
          ),
        ]
      }

      function renderList() {
        return h('aside', { class: 'qc-list' }, [
          h('div', { class: 'qc-list-head' }, [
            h('input', {
              type: 'search',
              value: filter.value,
              'aria-label': '搜索会话',
              placeholder: '搜索会话',
              onInput: (event) => (filter.value = event.target.value),
            }),
            platforms.value.length > 1
              ? h(
                  'select',
                  {
                    value: platformFilter.value,
                    'aria-label': '筛选平台',
                    onChange: (event) => {
                      const platform = event.target.value
                      platformFilter.value = platform
                      if (platform && current.value?.platform !== platform)
                        open(null)
                    },
                  },
                  [
                    h('option', { value: '' }, '全部平台'),
                    ...platforms.value.map((platform) =>
                      h('option', { value: platform }, platformName(platform))
                    ),
                  ]
                )
              : null,
          ]),
          chatError.value
            ? h('p', { class: 'qc-error', role: 'alert' }, chatError.value)
            : null,
          loadingChats.value
            ? h(
                'p',
                { class: 'qc-list-empty', role: 'status' },
                '正在加载会话…'
              )
            : !filtered.value.length
              ? h('p', { class: 'qc-list-empty' }, '没有匹配的会话。')
              : h(
                  'ul',
                  filtered.value.map((chat) => {
                    const name = nameOf(chat)
                    const active = keyOf(chat) === selected.value
                    return h(
                      'li',
                      { key: keyOf(chat) },
                      h(
                        'button',
                        {
                          type: 'button',
                          class: ['qc-list-row', active && 'is-selected'],
                          'aria-current': active ? 'true' : undefined,
                          onClick: () => open(chat),
                        },
                        [
                          avatar(name, chat.id, undefined, chat.avatar),
                          h('span', { class: 'qc-list-name' }, [
                            h('strong', name),
                          ]),
                          h('time', timeOf(chat.time)),
                          h(
                            'small',
                            { class: 'qc-list-sub' },
                            descriptionOf(chat)
                          ),
                        ]
                      )
                    )
                  })
                ),
        ])
      }

      function renderPanel(chat) {
        if (!panel.value) return null
        const { kind, target, parent } = panel.value
        const members = kind === 'members'
        const title = members
          ? '已记录成员'
          : target.kind === 'group'
            ? '群配置'
            : '用户配置'
        return h('aside', { class: 'qc-panel', 'aria-label': title }, [
          h('header', [
            h(
              'button',
              {
                type: 'button',
                class: ['qc-icon qc-panel-back', parent && 'has-parent'],
                'aria-label': parent ? '返回已记录成员' : '返回聊天',
                onClick: () =>
                  parent
                    ? showPanel(parent.kind, parent.target)
                    : (panel.value = null),
              },
              '‹'
            ),
            h('h2', title),
            h(
              'button',
              {
                type: 'button',
                class: 'qc-icon qc-panel-close',
                'aria-label': '关闭详情',
                onClick: () => (panel.value = null),
              },
              '×'
            ),
          ]),
          members
            ? h(ChatMembers, {
                chat,
                onUser: (row) =>
                  showUser(chat, row, { kind: 'members', target: chat }),
              })
            : h(ChatSettings, {
                target,
                features: Features,
                key: JSON.stringify([target.kind, target.selfId, target.id]),
              }),
        ])
      }

      function renderChat(chat) {
        if (!chat)
          return h(
            'main',
            { class: 'qc-empty' },
            h('span', '从左侧选择一个会话')
          )
        const key = keyOf(chat)
        return h('main', { class: 'qc-chat', key }, [
          h('header', { class: 'qc-chat-head' }, [
            h(
              'button',
              {
                type: 'button',
                class: 'qc-icon qc-back',
                'aria-label': '返回会话列表',
                onClick: () => open(null),
              },
              '‹'
            ),
            avatar(nameOf(chat), chat.id, undefined, chat.avatar),
            h(
              chat.platform === 'qq' ? 'button' : 'div',
              {
                class: 'qc-chat-title',
                ...(chat.platform === 'qq'
                  ? {
                      type: 'button',
                      title: chat.kind === 'group' ? '群配置' : '用户配置',
                      onClick: () => showPanel('settings', chat),
                    }
                  : {}),
              },
              [h('strong', nameOf(chat)), h('small', descriptionOf(chat))]
            ),
            chat.platform === 'qq'
              ? h('div', { class: 'qc-menu' }, [
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'qc-icon',
                      'aria-label': '会话选项',
                      'aria-expanded': menu.value,
                      onClick: () => (menu.value = !menu.value),
                    },
                    '⋯'
                  ),
                  menu.value
                    ? h(
                        'div',
                        {
                          class: 'qc-menu-popover',
                          onKeydown: (event) => {
                            if (event.key === 'Escape') menu.value = false
                          },
                        },
                        [
                          chat.kind === 'group'
                            ? h(
                                'button',
                                {
                                  type: 'button',
                                  onClick: () => showPanel('members', chat),
                                },
                                '已记录成员'
                              )
                            : null,
                          h(
                            'button',
                            {
                              type: 'button',
                              onClick: () => showPanel('settings', chat),
                            },
                            chat.kind === 'group' ? '群配置' : '用户配置'
                          ),
                        ]
                      )
                    : null,
                ])
              : null,
          ]),
          h(
            'div',
            {
              class: 'qc-history',
              ref: scroller,
              'aria-label': '聊天记录',
              onScroll: () => {
                actionMenu.value = null
                if (nearBottom() && newMessages.value) {
                  newMessages.value = false
                  scheduleHistory()
                }
              },
            },
            [
              hasOlder.value
                ? h(
                    'button',
                    {
                      type: 'button',
                      class: 'qc-load-more',
                      disabled: loading.value,
                      onClick: () => history({ older: true }),
                    },
                    '加载更早的消息'
                  )
                : null,
              !messages.value.length && !loading.value && !error.value
                ? h('p', { class: 'qc-empty' }, '暂无聊天记录。')
                : null,
              !messages.value.length && loading.value
                ? h('p', { class: 'qc-empty', role: 'status' }, '正在加载消息…')
                : null,
              error.value
                ? h('p', { class: 'qc-error', role: 'alert' }, error.value)
                : null,
              ...messages.value.map((row, index) =>
                h('div', { key: row.id }, renderMessage(chat, row, index))
              ),
              newMessages.value
                ? h(
                    'button',
                    {
                      type: 'button',
                      class: 'qc-new-messages',
                      title: '查看新消息',
                      'aria-label': '查看新消息',
                      onClick: () => {
                        bottom()
                        void history()
                      },
                    },
                    '↓'
                  )
                : null,
            ]
          ),
          h(HoldSend, {
            ref: composer,
            key: `compose:${key}`,
            chat,
            modelValue: drafts.value[key] ?? '',
            quote: replies.value[key],
            onClearQuote: () => delete replies.value[key],
            'onUpdate:modelValue': (value) => (drafts.value[key] = value),
            onSent: () => {
              if (selected.value === key) scheduleHistory()
            },
          }),
        ])
      }

      return () => {
        const layout = resolveComponent('k-layout')
        const chat = current.value
        return h(layout, null, {
          default: () =>
            h(
              'div',
              {
                ref: root,
                class: [
                  'qc-root',
                  chat && 'has-chat',
                  panel.value && 'has-panel',
                ],
              },
              [
                renderList(),
                renderChat(chat),
                chat ? renderPanel(chat) : null,
                chat ? renderActionMenu(chat) : null,
              ]
            ),
        })
      }
    },
  })
}

export function registerChat(ctx, Features) {
  icons.register('qqbot-chat', {
    render: () =>
      h(
        'svg',
        {
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 1.7,
        },
        [
          h('path', {
            d: 'M20.5 11.5a6.5 6.5 0 0 1-6.5 6.5H8l-4.5 2v-5.3A6.5 6.5 0 0 1 8.5 5H14a6.5 6.5 0 0 1 6.5 6.5Z',
          }),
          h('path', { d: 'M8.5 10.5h7m-7 3h4' }),
        ]
      ),
  })
  ctx.page({
    path: '/qqbot-chat',
    name: '聊天',
    authority: 4,
    order: 87,
    icon: 'qqbot-chat',
    component: createChatPage(Features),
  })
}
