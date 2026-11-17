import { defineComponent, h, nextTick, onMounted, onUnmounted, ref, resolveComponent, watch } from '../vue.js'
import { useRoute, useRouter } from '../vue-router.js'
import { icons, send, store } from '../client.js'

function fmt(n) {
  return (n ?? 0).toLocaleString('en-US')
}
function fmtShort(n) {
  n = n ?? 0
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.?0+$/, '') + 'k'
  return String(Math.round(n))
}
function when(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function ident(u) {
  const parts = []
  if (u?.name) parts.push(h('span', { class: 'la-nick' }, u.name))
  if (u?.account) parts.push(h('span', { class: 'la-acct' }, u.account))
  // A group's id is `group:<platform>:<channel>`; its account already shows the channel.
  parts.push(h('span', { class: 'la-uid' }, typeof u?.id === 'string' ? '(群会话)' : `(#${u?.id ?? '?'})`))
  return parts
}
function toolNames(json) {
  try {
    const arr = JSON.parse(json)
    const names = (Array.isArray(arr) ? arr : [])
      .map((t) => t?.function?.name || t?.name)
      .filter(Boolean)
    return names.join(', ') || '工具'
  } catch {
    return '工具'
  }
}
function prettyJson(json) {
  try {
    return JSON.stringify(JSON.parse(json), null, 2)
  } catch {
    return json
  }
}
function fold(cls, summary, body) {
  return h('details', { class: 'la-fold ' + cls }, [
    h('summary', {}, summary),
    h('pre', {}, body),
  ])
}

function trendSvg(trend) {
  const W = 720
  const H = 160
  const pad = { l: 6, r: 6, t: 10, b: 6 }
  const n = trend.length
  const max = Math.max(1, ...trend.map((d) => d.promptTokens + d.completionTokens))
  const iw = W - pad.l - pad.r
  const ih = H - pad.t - pad.b
  const x = (i) => pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw)
  const y = (v) => pad.t + ih - (v / max) * ih
  const p = trend.map((d, i) => `${x(i)},${y(d.promptTokens)}`)
  const t = trend.map((d, i) => `${x(i)},${y(d.promptTokens + d.completionTokens)}`)
  const base = `${pad.l + iw},${pad.t + ih} ${pad.l},${pad.t + ih}`
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg"><polygon points="${t.join(' ')} ${base}" fill="var(--k-color-primary,#6a5acd)" fill-opacity="0.18"/><polygon points="${p.join(' ')} ${base}" fill="var(--k-color-primary,#6a5acd)" fill-opacity="0.35"/><polyline points="${t.join(' ')}" fill="none" stroke="var(--k-color-primary,#6a5acd)" stroke-width="1.5"/></svg>`
}

function utf8Len(s) {
  return new TextEncoder().encode(s ?? '').length
}

// 长期记忆编辑卡片：进入总览时 memory-get 载入，实时字节计数对上限，
// 超限标红并禁用保存；清空走 window.confirm 二次确认。隐私敏感。
const MemoryCard = defineComponent({
  name: 'LaMemoryCard',
  props: { id: { type: Number, required: true } },
  setup(props) {
    const content = ref('')
    const loaded = ref(false)
    const saving = ref(false)
    const clearing = ref(false)
    const hardLimit = ref(3300)
    const meta = ref(null)
    const msg = ref('')

    async function load() {
      loaded.value = false
      msg.value = ''
      try {
        const r = await send('llm-admin/memory-get', { id: props.id })
        content.value = r.content ?? ''
        hardLimit.value = r.hardLimit ?? 3300
        meta.value = r
      } catch (e) {
        msg.value = e?.message ?? String(e)
      } finally {
        loaded.value = true
      }
    }
    async function save() {
      saving.value = true
      msg.value = ''
      try {
        const r = await send('llm-admin/memory-save', {
          id: props.id,
          content: content.value,
        })
        if (r.ok) msg.value = `已保存（${r.byteSize} 字节）`
        else msg.value = r.error || '保存失败'
        if (r.ok) meta.value = { ...(meta.value || {}), byteSize: r.byteSize }
      } catch (e) {
        msg.value = e?.message ?? String(e)
      } finally {
        saving.value = false
      }
    }
    async function clear() {
      if (!window.confirm('确认清空该用户长期记忆？此操作不可撤销。')) return
      clearing.value = true
      msg.value = ''
      try {
        const r = await send('llm-admin/memory-clear', { id: props.id })
        if (r.ok) {
          content.value = ''
          meta.value = null
          msg.value = '已清空'
        } else {
          msg.value = '无记忆可清空'
        }
      } catch (e) {
        msg.value = e?.message ?? String(e)
      } finally {
        clearing.value = false
      }
    }

    onMounted(load)
    watch(() => props.id, load)

    return () => {
      const KCard = resolveComponent('k-card')
      const size = utf8Len(content.value)
      const over = size > hardLimit.value
      return h(KCard, { class: 'la-panel la-mem' }, {
        default: () => [
          h('div', { class: 'la-panel-title' }, '长期记忆 · 隐私敏感'),
          !loaded.value
            ? h('p', { class: 'la-dim' }, '加载中…')
            : h('div', { class: 'la-mem-body' }, [
                h('textarea', {
                  class: ['la-mem-textarea', over ? 'over' : ''],
                  value: content.value,
                  spellcheck: 'false',
                  placeholder: '（该用户暂无长期记忆，可在此写入）',
                  onInput: (e) => (content.value = e.target.value),
                }),
                h('div', { class: 'la-mem-bar' }, [
                  h(
                    'span',
                    { class: ['la-mem-count', over ? 'over' : ''] },
                    `${size} / ${hardLimit.value} 字节`
                  ),
                  meta.value
                    ? h(
                        'span',
                        { class: 'la-dim la-mem-updated' },
                        `更新 ${meta.value.updateCount ?? 0} 次 · ${when(meta.value.lastUpdated)}`
                      )
                    : null,
                ]),
                h('div', { class: 'la-mem-actions' }, [
                  h(
                    'button',
                    {
                      class: 'la-btn',
                      disabled: over || saving.value,
                      onClick: save,
                    },
                    saving.value ? '保存中…' : '保存'
                  ),
                  h(
                    'button',
                    {
                      class: 'la-btn la-mem-clear',
                      disabled: clearing.value,
                      onClick: clear,
                    },
                    clearing.value ? '清空中…' : '清空 ⚠'
                  ),
                  msg.value ? h('span', { class: 'la-mem-msg' }, msg.value) : null,
                ]),
              ]),
        ],
      })
    }
  },
})

function overviewView(o) {
  const KCard = resolveComponent('k-card')
  const cards = [
    { label: '调用次数', v: fmt(o.calls) },
    {
      label: '总 Token',
      v: fmt(o.totalTokens),
      sub: `输入 ${fmtShort(o.promptTokens)} · 输出 ${fmtShort(o.completionTokens)} · 缓存 ${fmtShort(o.cachedTokens)}`,
    },
    { label: '会话数', v: fmt(o.sessionCount) },
    { label: '活跃区间', v: '', sub: `${when(o.firstActive)} ~ ${when(o.lastActive)}` },
  ]
  const first = o.trend[0]?.date ?? ''
  const last = o.trend[o.trend.length - 1]?.date ?? ''
  return h('div', { class: 'la-overview' }, [
    h(
      'div',
      { class: 'la-cards' },
      cards.map((c) =>
        h('div', { class: 'la-card' }, [
          h('div', { class: 'la-card-label' }, c.label),
          c.v ? h('div', { class: 'la-card-value' }, c.v) : null,
          c.sub ? h('div', { class: 'la-card-sub' }, c.sub) : null,
        ])
      )
    ),
    h(KCard, { class: 'la-panel' }, {
      default: () => [
        h('div', { class: 'la-panel-title' }, '近 30 天用量趋势'),
        h('div', { class: 'la-chart', innerHTML: trendSvg(o.trend) }),
        h('div', { class: 'la-chart-axis' }, [h('span', {}, first), h('span', {}, last)]),
      ],
    }),
    h(KCard, { class: 'la-panel' }, {
      default: () => [
        h('div', { class: 'la-panel-title' }, '模型分布'),
        o.models.length
          ? h(
              'div',
              { class: 'la-models' },
              o.models.map((m) =>
                h('div', { class: 'la-model-row' }, [
                  h('span', {}, m.model),
                  h('span', { class: 'la-dim' }, `${fmtShort(m.totalTokens)} tok · ${fmt(m.calls)} 次`),
                ])
              )
            )
          : h('p', { class: 'la-dim' }, '（无数据）'),
      ],
    }),
    // Groups have no long-term memory of their own.
    typeof o.id === 'number' ? h(MemoryCard, { id: o.id, key: o.id }) : null,
  ])
}

// agent 消息的 token 消耗徽标：↑输入 ↓输出（有缓存则 ⚡缓存），hover 看精确值。
// cachedTokens ⊂ promptTokens，仅展示不叠加。
function msgTokens(u) {
  if (!u) return null
  const prompt = u.promptTokens ?? 0
  const completion = u.completionTokens ?? 0
  const cached = u.cachedTokens ?? 0
  const total = u.totalTokens ?? prompt + completion
  if (!total && !prompt && !completion) return null
  const parts = [`↑${fmtShort(prompt)}`, `↓${fmtShort(completion)}`]
  if (cached) parts.push(`⚡${fmtShort(cached)}`)
  const title = `输入 ${fmt(prompt)} · 输出 ${fmt(completion)} · 缓存 ${fmt(cached)} · 合计 ${fmt(total)}`
  return h('span', { class: 'la-msg-tokens', title }, parts.join(' '))
}

function renderMsg(m) {
  if (m.role === 'tool') {
    // 工具结果：吵，默认折叠
    return h('div', { class: 'la-msg la-msg-tool' }, [
      fold('la-tool', `🔧 ${m.toolName || '工具'} 结果`, m.content),
    ])
  }
  const kids = []
  if (m.role === 'assistant' && m.reasoning)
    kids.push(fold('la-reasoning', '💭 思维链', m.reasoning))
  if (m.content) kids.push(h('div', { class: 'la-msg-text' }, m.content))
  if (m.role === 'user' && m.raw && m.raw !== m.content)
    kids.push(fold('la-envelope', '📄 原始 envelope', m.raw))
  if (m.role === 'assistant' && m.toolCalls)
    kids.push(fold('la-tool', `🔧 调用 ${toolNames(m.toolCalls)}`, prettyJson(m.toolCalls)))
  const label = m.role === 'user' ? m.speaker || '用户' : m.role === 'assistant' ? 'SILI' : m.role
  const roleKids = [
    h('span', {
      class: 'la-msg-name',
      style: m.role === 'user' && m.speaker ? { color: speakerColor(m.speaker), fontWeight: 600 } : null,
    }, label),
  ]
  if (m.steered) roleKids.push(h('span', { class: 'la-msg-steered', title: 'SILI 回复途中发来，她从工具结果里读到' }, '↪ 回复中插话'))
  if (m.role === 'assistant' && m.model)
    roleKids.push(h('span', { class: 'la-msg-model' }, m.model))
  const meta = [h('span', { class: 'la-msg-time' }, when(m.time))]
  if (m.role === 'assistant') {
    const t = msgTokens(m.usage)
    if (t) meta.push(t)
  }
  return h('div', { class: `la-msg la-msg-${m.role}` }, [
    h('div', { class: 'la-msg-role' }, roleKids),
    h('div', { class: 'la-bubble' }, kids),
    h('div', { class: 'la-msg-meta' }, meta),
  ])
}

// 群聊里给每个说话人一个固定颜色，便于分辨谁在说话
const SPEAKER_COLORS = ['#e07a5f', '#3d9970', '#4a90d9', '#c06c84', '#d4a017', '#7b68ee', '#20a4a4']
function speakerColor(name) {
  let n = 0
  for (const ch of name || '') n = (n * 31 + ch.charCodeAt(0)) >>> 0
  return SPEAKER_COLORS[n % SPEAKER_COLORS.length]
}

function chatView(msgs, sentinelRef, loadingMore) {
  if (msgs === null) return h('div', { class: 'la-dim la-chat-empty' }, '加载中…')
  if (!msgs.length) return h('div', { class: 'la-dim la-chat-empty' }, '（空会话）')
  // 顶部哨兵：滚动容器是 .la-right，IntersectionObserver 盯这个哨兵进视口触发上滚加载。
  return h('div', { class: 'la-chat' }, [
    h('div', { class: 'la-chat-top', ref: sentinelRef }),
    loadingMore ? h('div', { class: 'la-dim la-chat-more' }, '加载更早…') : null,
    ...msgs.map(renderMsg),
  ])
}

const Admin = defineComponent({
  name: 'LlmAdmin',
  setup() {
    const route = useRoute()
    const router = useRouter()

    const SEARCH_PAGE = 50
    const SESSION_PAGE = 30

    const q = ref('')
    const results = ref(null)
    const searchTotal = ref(0)
    const searchOffset = ref(0)
    const searchingMore = ref(false)
    const searching = ref(false)
    const overview = ref(null)
    const sessions = ref(null)
    const sessionTotal = ref(0)
    const sessionOffset = ref(0)
    const sessionsMore = ref(false)
    const msgs = ref(null)
    const MSG_PAGE = 20
    const earliestTurn = ref(null)
    const msgsHasMore = ref(false)
    const loadingMoreMsgs = ref(false)
    const chatEl = ref(null) // 滚动容器 = .la-right（滚动条贴面板最右缘）
    const sentinelEl = ref(null) // .la-chat 顶部哨兵，供 IntersectionObserver 触发上滚加载
    let msgObserver = null
    const err = ref('')
    const ready = ref(false)
    const rotating = ref(false)

    // A user id, or `group:<platform>:<channel>` for a group's shared conversation.
    const uid = () => {
      const q = route.query.user
      if (!q) return null
      return String(q).startsWith('group:') ? String(q) : Number(q)
    }
    const cid = () => route.query.session || null
    const kindWord = () => (typeof uid() === 'string' ? '群' : '用户')
    const kind = ref('all')

    async function doSearch() {
      searching.value = true
      searchOffset.value = 0
      err.value = ''
      try {
        const res = await send('llm-admin/search', {
          q: q.value,
          kind: kind.value,
          limit: SEARCH_PAGE,
          offset: 0,
        })
        results.value = res.users
        searchTotal.value = res.total
      } catch (e) {
        err.value = e?.message ?? String(e)
      } finally {
        searching.value = false
      }
    }
    async function loadMoreSearch() {
      searchingMore.value = true
      err.value = ''
      try {
        const offset = searchOffset.value + SEARCH_PAGE
        const res = await send('llm-admin/search', {
          q: q.value,
          kind: kind.value,
          limit: SEARCH_PAGE,
          offset,
        })
        searchOffset.value = offset
        results.value = [...(results.value || []), ...res.users]
        searchTotal.value = res.total
      } catch (e) {
        err.value = e?.message ?? String(e)
      } finally {
        searchingMore.value = false
      }
    }

    const openUser = (id) => router.push({ path: '/llm-admin', query: { user: id } })
    const openSession = (conv) =>
      router.push({ path: '/llm-admin', query: { user: uid(), session: conv } })
    const backToOverview = () => {
      if (cid()) router.push({ path: '/llm-admin', query: { user: uid() } })
    }
    const goSearch = () => router.push({ path: '/llm-admin', query: {} })

    // 窄屏「导航栈」：会话列表打底，详情从右滑入覆盖。宽屏是并排 split view，此状态被忽略。
    // 聊天层走 ?session 路由；总览层因宽屏常驻右栏、窄屏才需显式打开，用本地 overviewOpen。
    const overviewOpen = ref(false)
    const onHeadClick = () => {
      if (cid()) backToOverview()
      else overviewOpen.value = true
    }
    const closePane = () => {
      if (cid()) backToOverview()
      else overviewOpen.value = false
    }

    let loadedUser = null
    let loadedConv = null
    async function loadUser(id) {
      overview.value = null
      sessions.value = null
      sessionOffset.value = 0
      sessionTotal.value = 0
      try {
        overview.value = await send('llm-admin/overview', { id })
        const res = await send('llm-admin/sessions', {
          id,
          limit: SESSION_PAGE,
          offset: 0,
        })
        sessions.value = res.rows
        sessionTotal.value = res.total
      } catch (e) {
        err.value = e?.message ?? String(e)
      }
    }
    // 强制轮转：写操作，二次确认后 send，成功刷新会话列表（新会话应标「当前」）
    async function rotate(e) {
      e.stopPropagation() // 防冒泡触发头部「回总览」
      const id = uid()
      if (id == null || rotating.value) return
      if (
        !window.confirm(
          typeof id === 'string'
            ? '确认给这个群强制轮转 session？群里所有人的上下文都会清空，下条消息将从空白新会话开始。'
            : '确认给该用户强制轮转 session？下条消息将从空白新会话开始。'
        )
      )
        return
      rotating.value = true
      err.value = ''
      try {
        await send('llm-admin/rotate', { id })
        await loadUser(id)
      } catch (e2) {
        err.value = e2?.message ?? String(e2)
      } finally {
        rotating.value = false
      }
    }
    async function loadMoreSessions() {
      const id = uid()
      if (id == null) return
      sessionsMore.value = true
      err.value = ''
      try {
        const offset = sessionOffset.value + SESSION_PAGE
        const res = await send('llm-admin/sessions', {
          id,
          limit: SESSION_PAGE,
          offset,
        })
        sessionOffset.value = offset
        sessions.value = [...(sessions.value || []), ...res.rows]
        sessionTotal.value = res.total
      } catch (e) {
        err.value = e?.message ?? String(e)
      } finally {
        sessionsMore.value = false
      }
    }
    async function loadSession(conv) {
      msgs.value = null
      earliestTurn.value = null
      msgsHasMore.value = false
      try {
        const res = await send('llm-admin/session', {
          conversationId: conv,
          limit: MSG_PAGE,
          beforeTurn: null,
        })
        msgs.value = res.messages
        earliestTurn.value = res.earliestTurn
        msgsHasMore.value = res.hasMore
        // 渲染后定位到底部（聊天软件式：最新在下方），再挂哨兵 observer
        await nextTick()
        const el = chatEl.value
        if (el) el.scrollTop = el.scrollHeight
        setupMsgObserver()
      } catch (e) {
        err.value = e?.message ?? String(e)
      }
    }
    // 上滚加载更早：prepend 到头部并保持视觉位置不跳
    async function loadMoreMsgs() {
      const conv = cid()
      if (conv == null || !msgsHasMore.value || loadingMoreMsgs.value) return
      loadingMoreMsgs.value = true
      err.value = ''
      const el = chatEl.value
      const prevHeight = el ? el.scrollHeight : 0
      try {
        const res = await send('llm-admin/session', {
          conversationId: conv,
          limit: MSG_PAGE,
          beforeTurn: earliestTurn.value,
        })
        msgs.value = [...res.messages, ...(msgs.value || [])]
        earliestTurn.value = res.earliestTurn ?? earliestTurn.value
        msgsHasMore.value = res.hasMore
        await nextTick()
        if (el) el.scrollTop += el.scrollHeight - prevHeight
      } catch (e) {
        err.value = e?.message ?? String(e)
      } finally {
        loadingMoreMsgs.value = false
      }
    }
    // 无限上滚：IntersectionObserver 盯顶部哨兵，进视口（root=.la-right，提前 80px）就加载更早。
    // 比 scroll 监听更地道：无需猜阈值、无高频事件；防跳仍靠 loadMoreMsgs 里的 scrollHeight 补偿。
    function setupMsgObserver() {
      teardownMsgObserver()
      const root = chatEl.value
      const target = sentinelEl.value
      if (!root || !target || typeof IntersectionObserver === 'undefined') return
      msgObserver = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) loadMoreMsgs()
        },
        { root, rootMargin: '80px 0px 0px 0px', threshold: 0 }
      )
      msgObserver.observe(target)
    }
    function teardownMsgObserver() {
      if (msgObserver) {
        msgObserver.disconnect()
        msgObserver = null
      }
    }
    onUnmounted(teardownMsgObserver)

    // 路由驱动的数据加载（真实 URL：?user=&session=）
    watch(
      () => [ready.value, route.query.user, route.query.session],
      () => {
        if (!ready.value) return
        overviewOpen.value = false // 任何路由变化都收起窄屏总览覆盖层
        const u = uid()
        const c = cid()
        if (u == null) {
          loadedUser = loadedConv = null
          overview.value = sessions.value = msgs.value = null
          msgsHasMore.value = false
          teardownMsgObserver()
          return
        }
        if (loadedUser !== u) {
          loadedUser = u
          loadUser(u)
        }
        if (c) {
          if (loadedConv !== c) {
            loadedConv = c
            loadSession(c)
          }
        } else {
          loadedConv = null
          msgs.value = null
          msgsHasMore.value = false
          teardownMsgObserver()
        }
      },
      { immediate: true }
    )

    onMounted(() => {
      if (store.user) ready.value = true
      else {
        const stop = watch(
          () => store.user,
          (u) => {
            if (u) {
              stop()
              ready.value = true
            }
          }
        )
      }
    })

    function searchView() {
      // 打开页面就列出来，不用先点搜索
      if (results.value === null && ready.value && !searching.value && !err.value) doSearch()
      const tab = (value, label) =>
        h('button', {
          class: ['la-tab', kind.value === value ? 'is-active' : ''],
          type: 'button',
          onClick: () => { kind.value = value; doSearch() },
        }, label)
      const row = (u) =>
        h('tr', { class: 'la-row', key: u.id, onClick: () => openUser(u.id) }, [
          h('td', { class: 'la-cell-name' }, [
            h('div', {}, u.name || h('span', { class: 'la-dim' }, '（无名）')),
            h('div', { class: 'la-dim la-cell-id' }, u.kind === 'group' ? '群会话' : `#${u.id}`),
          ]),
          h('td', { class: 'la-dim la-cell-accts' }, u.accounts.map((a) => h('div', { key: a }, a))),
          h('td', {}, when(u.lastActive)),
          h('td', { class: 'la-num' }, fmt(u.sessions)),
          h('td', { class: 'la-num' }, fmt(u.calls)),
          h('td', { class: 'la-num' }, fmtShort(u.totalTokens)),
          h('td', { class: 'la-num' }, u.memoryBytes == null ? '—' : `${fmt(u.memoryBytes)} B`),
        ])
      return h('div', { class: 'la-search' }, [
        h('div', { class: 'la-notice' }, '⚠ 含用户隐私数据（长期记忆 / 会话正文）· 仅 sysop 可见'),
        h('form', { class: 'la-search-form', onSubmit: (e) => { e.preventDefault(); doSearch() } }, [
          h('div', { class: 'la-tabs' }, [tab('all', '全部'), tab('user', '用户'), tab('group', '群')]),
          h('input', {
            class: 'la-input',
            placeholder: '#id / 账号 / 名称',
            value: q.value,
            onInput: (e) => (q.value = e.target.value),
          }),
          h('button', { class: 'la-btn', type: 'submit', disabled: searching.value }, searching.value ? '搜索中…' : '搜索'),
        ]),
        err.value ? h('div', { class: 'la-err' }, err.value) : null,
        results.value === null
          ? h('p', { class: 'la-dim' }, '加载中…')
          : results.value.length
            ? h('div', {}, [
                h('div', { class: 'la-dim la-count' }, `共 ${searchTotal.value} 个，按最近活跃排序`),
                h('table', { class: 'la-table' }, [
                  h('thead', {}, h('tr', {}, ['名称', '账号', '最近活跃', '会话', '调用', 'token', '记忆'].map((t) => h('th', { key: t }, t)))),
                  h('tbody', {}, results.value.map(row)),
                ]),
                results.value.length < searchTotal.value
                  ? h(
                      'button',
                      {
                        class: 'la-btn la-more',
                        disabled: searchingMore.value,
                        onClick: loadMoreSearch,
                      },
                      searchingMore.value
                        ? '加载中…'
                        : `加载更多（${results.value.length}/${searchTotal.value}）`
                    )
                  : null,
              ])
            : h('p', { class: 'la-dim' }, '（无匹配）'),
      ])
    }

    function detailView() {
      const o = overview.value
      const inSession = !!cid()
      const headIdent = o || { id: uid() }
      const left = h('div', { class: 'la-left' }, [
        h(
          'div',
          {
            class: ['la-user-head', inSession ? 'clickable' : 'la-head-tap'],
            title: inSession ? `点此返回${kindWord()}总览` : `点此查看${kindWord()}总览`,
            onClick: onHeadClick,
          },
          [
            h('div', { class: 'la-user-head-top' }, [
              h('button', { class: 'la-back', onClick: (e) => { e.stopPropagation(); goSearch() } }, '← 返回搜索'),
              h(
                'button',
                {
                  class: 'la-btn la-rotate',
                  disabled: rotating.value,
                  onClick: rotate,
                },
                rotating.value ? '轮转中…' : '强制轮转 ⚠'
              ),
            ]),
            h('div', { class: 'la-user-ident' }, ident(headIdent)),
            h('div', { class: 'la-user-meta' }, o ? `${o.sessionCount} 个会话 · ${fmtShort(o.totalTokens)} tok` : '加载中…'),
            inSession ? h('div', { class: 'la-user-hint' }, `← 点此看${kindWord()}总览`) : null,
          ]
        ),
        h('div', { class: 'la-session-list' },
          sessions.value === null
            ? [h('p', { class: 'la-dim' }, '加载中…')]
            : sessions.value.length
              ? [
                  ...sessions.value.map((s) =>
                    h(
                      'div',
                      {
                        class: ['la-session', cid() === s.conversationId ? 'active' : ''],
                        onClick: () => openSession(s.conversationId),
                      },
                      [
                        h('div', { class: 'la-session-title' }, [
                          s.isCurrent ? h('span', { class: 'la-badge la-badge-cur' }, '当前') : null,
                          s.isCompacted ? h('span', { class: 'la-badge' }, '压缩') : null,
                          h('span', {}, s.title),
                        ]),
                        h('div', { class: 'la-session-meta' }, `${when(s.lastUsedAt)} · ${s.turns} 轮`),
                      ]
                    )
                  ),
                  sessions.value.length < sessionTotal.value
                    ? h(
                        'button',
                        {
                          class: 'la-btn la-more',
                          disabled: sessionsMore.value,
                          onClick: loadMoreSessions,
                        },
                        sessionsMore.value
                          ? '加载中…'
                          : `加载更多（${sessions.value.length}/${sessionTotal.value}）`
                      )
                    : null,
                ]
              : [h('p', { class: 'la-dim' }, '（无会话）')]
        ),
      ])
      const paneOpen = inSession || overviewOpen.value
      const paneTitle = inSession
        ? sessions.value?.find((s) => s.conversationId === cid())?.title || '会话回放'
        : '用户总览'
      const pane = h('div', { class: ['la-detail-pane', paneOpen ? 'la-pane-open' : ''] }, [
        // 窄屏导航栏（宽屏 CSS 隐藏）：返回 + 标题
        h('div', { class: 'la-pane-bar' }, [
          h('button', { class: 'la-pane-back', onClick: closePane }, '← 返回'),
          h('div', { class: 'la-pane-title' }, paneTitle),
        ]),
        h('div', { class: 'la-right', ref: chatEl }, [
          err.value ? h('div', { class: 'la-err' }, err.value) : null,
          inSession
            ? chatView(msgs.value, sentinelEl, loadingMoreMsgs.value)
            : o
              ? overviewView(o)
              : h('div', { class: 'la-dim' }, '加载中…'),
        ]),
      ])
      return h('div', { class: 'la-detail' }, [left, pane])
    }

    return () => {
      const KLayout = resolveComponent('k-layout')
      const body = !ready.value
        ? h('div', { class: 'la-dim' }, '鉴权中…')
        : uid() != null
          ? detailView()
          : searchView()
      return h(KLayout, null, { default: () => h('div', { class: 'la-root' }, [body]) })
    }
  },
})

export default (ctx) => {
  // 侧栏图标：人形（用户管理），与用量仪表盘的柱状图区分
  icons.register('llm-admin-users', {
    render: () =>
      h('svg', { viewBox: '0 0 24 24', fill: 'currentColor', xmlns: 'http://www.w3.org/2000/svg' }, [
        h('circle', { cx: 12, cy: 7.5, r: 4.5 }),
        h('path', { d: 'M3.5 21 a8.5 8.5 0 0 1 17 0 z' }),
      ]),
  })
  ctx.page({
    path: '/llm-admin',
    name: 'LLM 用户管理',
    authority: 4,
    order: 90,
    icon: 'llm-admin-users',
    component: Admin,
  })
}
