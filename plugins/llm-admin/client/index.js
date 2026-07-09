import { defineComponent, h, onMounted, ref, resolveComponent, watch } from '../vue.js'
import { useRoute, useRouter } from '../vue-router.js'
import { send, store } from '../client.js'

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
  parts.push(h('span', { class: 'la-uid' }, `(#${u?.id ?? '?'})`))
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
  ])
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
  const label = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'SILI' : m.role
  return h('div', { class: `la-msg la-msg-${m.role}` }, [
    h('div', { class: 'la-msg-role' }, label),
    h('div', { class: 'la-bubble' }, kids),
    h('div', { class: 'la-msg-time' }, when(m.time)),
  ])
}

function chatView(msgs) {
  if (msgs === null) return h('div', { class: 'la-dim la-chat-empty' }, '加载中…')
  if (!msgs.length) return h('div', { class: 'la-dim la-chat-empty' }, '（空会话）')
  return h('div', { class: 'la-chat' }, msgs.map(renderMsg))
}

const Admin = defineComponent({
  name: 'LlmAdmin',
  setup() {
    const route = useRoute()
    const router = useRouter()

    const q = ref('')
    const results = ref(null)
    const searching = ref(false)
    const overview = ref(null)
    const sessions = ref(null)
    const msgs = ref(null)
    const err = ref('')
    const ready = ref(false)

    const uid = () => (route.query.user ? Number(route.query.user) : null)
    const cid = () => route.query.session || null

    async function doSearch() {
      searching.value = true
      err.value = ''
      try {
        results.value = await send('llm-admin/search', { q: q.value })
      } catch (e) {
        err.value = e?.message ?? String(e)
      } finally {
        searching.value = false
      }
    }

    const openUser = (id) => router.push({ path: '/llm-admin', query: { user: id } })
    const openSession = (conv) =>
      router.push({ path: '/llm-admin', query: { user: uid(), session: conv } })
    const backToOverview = () => {
      if (cid()) router.push({ path: '/llm-admin', query: { user: uid() } })
    }
    const goSearch = () => router.push({ path: '/llm-admin', query: {} })

    let loadedUser = null
    let loadedConv = null
    async function loadUser(id) {
      overview.value = null
      sessions.value = null
      try {
        overview.value = await send('llm-admin/overview', { id })
        sessions.value = await send('llm-admin/sessions', { id })
      } catch (e) {
        err.value = e?.message ?? String(e)
      }
    }
    async function loadSession(conv) {
      msgs.value = null
      try {
        msgs.value = await send('llm-admin/session', { conversationId: conv })
      } catch (e) {
        err.value = e?.message ?? String(e)
      }
    }

    // 路由驱动的数据加载（真实 URL：?user=&session=）
    watch(
      () => [ready.value, route.query.user, route.query.session],
      () => {
        if (!ready.value) return
        const u = uid()
        const c = cid()
        if (u == null) {
          loadedUser = loadedConv = null
          overview.value = sessions.value = msgs.value = null
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
      return h('div', { class: 'la-search' }, [
        h('div', { class: 'la-notice' }, '⚠ 含用户隐私数据（长期记忆 / 会话正文）· 仅 sysop 可见'),
        h('form', { class: 'la-search-form', onSubmit: (e) => { e.preventDefault(); doSearch() } }, [
          h('input', {
            class: 'la-input',
            placeholder: '搜索用户： #id / platform:pid / 昵称（留空列全部）',
            value: q.value,
            onInput: (e) => (q.value = e.target.value),
          }),
          h('button', { class: 'la-btn', type: 'submit', disabled: searching.value }, searching.value ? '搜索中…' : '搜索'),
        ]),
        err.value ? h('div', { class: 'la-err' }, err.value) : null,
        results.value === null
          ? h('p', { class: 'la-dim' }, '输入后搜索，或留空点搜索列出全部聊过的用户。')
          : results.value.length
            ? h(
                'div',
                { class: 'la-result-list' },
                results.value.map((u) =>
                  h('div', { class: 'la-result', onClick: () => openUser(u.id) }, ident(u))
                )
              )
            : h('p', { class: 'la-dim' }, '（无匹配用户）'),
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
            class: ['la-user-head', inSession ? 'clickable' : ''],
            title: inSession ? '点此返回用户总览' : '',
            onClick: backToOverview,
          },
          [
            h('button', { class: 'la-back', onClick: (e) => { e.stopPropagation(); goSearch() } }, '← 返回搜索'),
            h('div', { class: 'la-user-ident' }, ident(headIdent)),
            h('div', { class: 'la-user-meta' }, o ? `${o.sessionCount} 个会话 · ${fmtShort(o.totalTokens)} tok` : '加载中…'),
            inSession ? h('div', { class: 'la-user-hint' }, '← 点此看用户总览') : null,
          ]
        ),
        h('div', { class: 'la-session-list' },
          sessions.value === null
            ? [h('p', { class: 'la-dim' }, '加载中…')]
            : sessions.value.length
              ? sessions.value.map((s) =>
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
                )
              : [h('p', { class: 'la-dim' }, '（无会话）')]
        ),
      ])
      const right = h('div', { class: 'la-right' }, [
        err.value ? h('div', { class: 'la-err' }, err.value) : null,
        inSession
          ? chatView(msgs.value)
          : o
            ? overviewView(o)
            : h('div', { class: 'la-dim' }, '加载中…'),
      ])
      return h('div', { class: 'la-detail' }, [left, right])
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
  ctx.page({
    path: '/llm-admin',
    name: 'LLM 用户管理',
    authority: 4,
    order: 90,
    component: Admin,
  })
}
