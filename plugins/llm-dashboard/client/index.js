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

// 环比：返回 { text, cls }
function delta(cur, prev) {
  if (!prev) return { text: '—', cls: 'flat' }
  const pct = ((cur - prev) / prev) * 100
  const sign = pct > 0 ? '↑' : pct < 0 ? '↓' : ''
  return { text: `${sign} ${Math.abs(pct).toFixed(0)}%`, cls: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat' }
}

function overviewCards(o) {
  const cards = [
    { label: '调用次数', cur: o.calls, prev: o.prev.calls },
    { label: '总 Token', cur: o.totalTokens, prev: o.prev.totalTokens },
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
        h('div', { class: `ld-delta ld-${d.cls}` }, d.text),
      ])
    })
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
          : h('div', { class: 'ld-grid' }, [overviewCards(s.overview)])

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
