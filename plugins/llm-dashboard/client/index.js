import { defineComponent, h, onMounted, ref, resolveComponent, watch } from '../vue.js'
import { send, store } from '../client.js'

const RANGES = [
  { value: 7, label: '7 天' },
  { value: 30, label: '30 天' },
  { value: 90, label: '90 天' },
]

function fmt(n) {
  return (n ?? 0).toLocaleString('en-US')
}

// 紧凑缩写：1_510_000 -> "1.51M"，515_000 -> "515k"（token 细分处用，省空间）
function fmtShort(n) {
  n = n ?? 0
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.?0+$/, '') + 'k'
  return String(Math.round(n))
}

// 环比：返回 { text, cls }
function delta(cur, prev) {
  if (!prev) return cur > 0 ? { text: '↑ 新增', cls: 'up' } : { text: '—', cls: 'flat' }
  const pct = ((cur - prev) / prev) * 100
  const sign = pct > 0 ? '↑' : pct < 0 ? '↓' : ''
  const abs = Math.abs(pct)
  const num = abs > 0 && abs < 0.5 ? '< 1%' : `${abs.toFixed(0)}%`
  return { text: `${sign} ${num}`, cls: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat' }
}

function overviewCards(o) {
  const cards = [
    { label: '调用次数', cur: o.calls, prev: o.prev.calls },
    {
      label: '总 Token',
      cur: o.totalTokens,
      prev: o.prev.totalTokens,
      sub: `输入 ${fmtShort(o.promptTokens)} · 输出 ${fmtShort(o.completionTokens)} · 缓存 ${fmtShort(o.cachedTokens)}`,
    },
    { label: '活跃用户', cur: o.activeUsers, prev: o.prev.activeUsers },
    { label: '会话数', cur: o.conversations, prev: o.prev.conversations },
  ]
  return h(
    'div',
    { class: 'ld-cards' },
    cards.map((c) => {
      const d = delta(c.cur, c.prev)
      return h('div', { class: 'ld-card' }, [
        h('div', { class: 'ld-card-label' }, c.label),
        h('div', { class: 'ld-card-value' }, fmt(c.cur)),
        c.sub ? h('div', { class: 'ld-card-sub' }, c.sub) : null,
        h('div', { class: `ld-delta ld-${d.cls}` }, d.text),
      ])
    })
  )
}

function rankRows(items, maxKey, rows) {
  const max = Math.max(1, ...items.map((it) => it[maxKey]))
  return items.map((it) =>
    h('div', { class: 'ld-rank-row', key: it.model ?? it.id }, [
      h('div', { class: 'ld-rank-bar', style: `width:${(it[maxKey] / max) * 100}%` }),
      h('div', { class: 'ld-rank-content' }, rows(it)),
    ])
  )
}

function modelPanel(models) {
  const KCard = resolveComponent('k-card')
  return h(
    KCard,
    { class: 'ld-panel' },
    {
      default: () => [
        h('div', { class: 'ld-panel-title' }, '各模型消耗'),
        models.length
          ? h(
              'div',
              { class: 'ld-ranks' },
              rankRows(models, 'totalTokens', (m) => [
                h('span', { class: 'ld-rank-name' }, m.model),
                h(
                  'span',
                  { class: 'ld-rank-metric' },
                  `${fmtShort(m.totalTokens)} tok (入 ${fmtShort(m.promptTokens)} / 出 ${fmtShort(m.completionTokens)}) · ${fmt(m.calls)} 次`
                ),
              ])
            )
          : h('p', { class: 'ld-empty' }, '（无数据）'),
      ],
    }
  )
}

function userPanel(users) {
  const KCard = resolveComponent('k-card')
  return h(
    KCard,
    { class: 'ld-panel' },
    {
      default: () => [
        h('div', { class: 'ld-panel-title' }, 'TOP 用户'),
        users.length
          ? h(
              'div',
              { class: 'ld-ranks' },
              rankRows(users, 'totalTokens', (u) => [
                h('span', { class: 'ld-rank-name' }, [
                  u.name ? h('span', { class: 'ld-user-nick' }, u.name) : null,
                  u.account ? h('span', { class: 'ld-user-acct' }, u.account) : null,
                  h('span', { class: 'ld-user-uid' }, `(#${u.id})`),
                ]),
                h('span', { class: 'ld-rank-metric' }, `${fmtShort(u.totalTokens)} tok · ${fmt(u.conversations)} 会话`),
              ])
            )
          : h('p', { class: 'ld-empty' }, '（无数据）'),
      ],
    }
  )
}

// Area/line only — NO in-SVG <text>. The chart is drawn with
// preserveAspectRatio="none" so it fills the container width; that non-uniform
// stretch would distort any <text> horizontally, so date labels are rendered as
// crisp HTML below the SVG (see trendPanel) instead of inside it.
function buildTrendSvg(trend) {
  const W = 720
  const H = 200
  const pad = { l: 8, r: 8, t: 12, b: 8 }
  const n = trend.length
  const max = Math.max(1, ...trend.map((d) => d.promptTokens + d.completionTokens))
  const iw = W - pad.l - pad.r
  const ih = H - pad.t - pad.b
  const x = (i) => pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw)
  const y = (v) => pad.t + ih - (v / max) * ih

  const promptPts = trend.map((d, i) => `${x(i)},${y(d.promptTokens)}`)
  const totalPts = trend.map((d, i) => `${x(i)},${y(d.promptTokens + d.completionTokens)}`)
  const base = `${pad.l + iw},${pad.t + ih} ${pad.l},${pad.t + ih}`

  const totalArea = `<polygon points="${totalPts.join(' ')} ${base}" fill="var(--k-color-primary,#6a5acd)" fill-opacity="0.18"/>`
  const promptArea = `<polygon points="${promptPts.join(' ')} ${base}" fill="var(--k-color-primary,#6a5acd)" fill-opacity="0.35"/>`
  const totalLine = `<polyline points="${totalPts.join(' ')}" fill="none" stroke="var(--k-color-primary,#6a5acd)" stroke-width="1.5"/>`

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">${totalArea}${promptArea}${totalLine}</svg>`
}

function trendPanel(trend) {
  const KCard = resolveComponent('k-card')
  const first = trend[0]?.date ?? ''
  const last = trend[trend.length - 1]?.date ?? ''
  return h(
    KCard,
    { class: 'ld-panel ld-trend' },
    {
      default: () => [
        h('div', { class: 'ld-panel-title' }, '用量趋势（下层 输入 / 上层含 输出）'),
        h('div', { class: 'ld-chart', innerHTML: buildTrendSvg(trend) }),
        h('div', { class: 'ld-chart-axis' }, [
          h('span', {}, first),
          h('span', {}, last),
        ]),
      ],
    }
  )
}

const Dashboard = defineComponent({
  name: 'LlmDashboard',
  setup() {
    const stats = ref(null)
    const loading = ref(false)
    const error = ref('')
    const range = ref(30)

    async function load() {
      loading.value = true
      error.value = ''
      try {
        stats.value = await send('llm-dashboard/stats', { range: range.value })
      } catch (err) {
        error.value = err?.message ?? String(err)
      } finally {
        loading.value = false
      }
    }

    function pick(v) {
      if (range.value === v) return
      range.value = v
      load()
    }

    onMounted(() => {
      if (store.user) load()
      else {
        const stop = watch(
          () => store.user,
          (u) => {
            if (u) {
              stop()
              load()
            }
          }
        )
      }
    })

    return () => {
      const KLayout = resolveComponent('k-layout')
      const KCard = resolveComponent('k-card')
      const s = stats.value

      const toolbar = h('div', { class: 'ld-toolbar' }, [
        h(
          'div',
          { class: 'ld-ranges' },
          RANGES.map((r) =>
            h(
              'button',
              { class: ['ld-range', range.value === r.value ? 'active' : ''], onClick: () => pick(r.value) },
              r.label
            )
          )
        ),
        h('button', { class: 'ld-refresh', disabled: loading.value, onClick: load }, loading.value ? '刷新中…' : '刷新'),
      ])

      const content = error.value
        ? h(KCard, { class: 'ld-error' }, { default: () => '加载失败：' + error.value })
        : !s
          ? h(KCard, {}, { default: () => (loading.value ? '加载中…' : '（无数据）') })
          : h('div', { class: 'ld-grid' }, [
              overviewCards(s.overview),
              trendPanel(s.trend),
              h('div', { class: 'ld-panels' }, [modelPanel(s.models), userPanel(s.users)]),
            ])

      return h(KLayout, null, { default: () => h('div', { class: 'ld-root' }, [toolbar, content]) })
    }
  },
})

export default (ctx) => {
  ctx.page({
    path: '/llm-dashboard',
    name: 'LLM 用量',
    authority: 3,
    order: 100,
    component: Dashboard,
  })
}
