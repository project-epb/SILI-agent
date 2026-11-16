import { defineComponent, h, onMounted, ref, resolveComponent } from '../vue.js'
import { icons, send } from '../client.js'

const PAGE_SIZE = 50
const SOURCE_LABELS = { requested: '用户要求', observed: 'LLM 发现' }
const CATEGORY_LABELS = { bug: 'Bug', suggestion: '建议', other: '其他' }

function when(ts) {
  const d = new Date(ts)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const Page = defineComponent({
  setup() {
    const rows = ref([])
    const total = ref(0)
    const page = ref(1)
    const all = ref(false)
    const loading = ref(false)
    const busy = ref(0)
    const err = ref('')

    const load = async (p = page.value) => {
      loading.value = true
      err.value = ''
      try {
        const res = await send('feedback/list', { all: all.value, page: p })
        rows.value = res.rows
        total.value = res.total
        page.value = p
      } catch (e) {
        err.value = String(e?.message ?? e)
      } finally {
        loading.value = false
      }
    }

    const setHandled = async (r) => {
      busy.value = r.id
      try {
        await send('feedback/set-handled', { id: r.id, handled: !r.handled })
        await load()
      } catch (e) {
        err.value = String(e?.message ?? e)
      } finally {
        busy.value = 0
      }
    }

    onMounted(() => load(1))

    const toolbar = () =>
      h('div', { class: 'fb-toolbar' }, [
        h('div', { class: 'fb-tabs' }, [
          [false, '未处理'],
          [true, '全部'],
        ].map(([value, label]) =>
          h('button', {
            class: ['fb-tab', all.value === value ? 'is-active' : ''],
            onClick: () => { all.value = value; load(1) },
          }, label))),
        h('span', { class: 'fb-dim' }, `共 ${total.value} 条`),
      ])

    const card = (r) =>
      h('div', { class: ['fb-card', r.handled ? 'is-handled' : ''], key: r.id }, [
        h('div', { class: 'fb-head' }, [
          h('span', { class: `fb-badge is-${r.category}` }, CATEGORY_LABELS[r.category] ?? r.category),
          h('span', { class: 'fb-badge' }, SOURCE_LABELS[r.source] ?? r.source),
          h('strong', { class: 'fb-title' }, r.title),
          h('button', {
            class: 'fb-btn',
            disabled: busy.value === r.id,
            onClick: () => setHandled(r),
          }, r.handled ? '标为未处理' : '标为已处理'),
        ]),
        h('p', { class: 'fb-summary' }, r.summary),
        h('blockquote', { class: 'fb-original' }, r.original),
        h('div', { class: 'fb-dim' }, [
          `#${r.id} · ${when(r.createdAt)} · `,
          h('span', { title: `${r.platform}:${r.userId}` }, `${r.userName || '未知用户'}（UID ${r.uid}）`),
          ' · ',
          r.channelId
            ? h('span', { title: r.channelId }, r.channelName || '未知群')
            : '私聊',
        ]),
      ])

    const pager = () => {
      const pages = Math.max(1, Math.ceil(total.value / PAGE_SIZE))
      if (pages <= 1) return null
      return h('div', { class: 'fb-pager' }, [
        h('button', { class: 'fb-btn', disabled: page.value <= 1, onClick: () => load(page.value - 1) }, '上一页'),
        h('span', { class: 'fb-dim' }, `第 ${page.value} / ${pages} 页`),
        h('button', { class: 'fb-btn', disabled: page.value >= pages, onClick: () => load(page.value + 1) }, '下一页'),
      ])
    }

    // Must render inside k-layout: a bare root sits under the activity bar
    // and its left edge is clipped.
    return () => {
      const KLayout = resolveComponent('k-layout')
      return h(KLayout, null, {
        default: () => h('div', { class: 'fb-root' }, [
          toolbar(),
          err.value ? h('p', { class: 'fb-err' }, err.value) : null,
          rows.value.length
            ? rows.value.map(card)
            : h('p', { class: 'fb-dim fb-empty' }, loading.value ? '加载中…' : '没有反馈。'),
          pager(),
        ]),
      })
    }
  },
})

export default (ctx) => {
  icons.register('feedback', {
    render: () =>
      h('svg', { viewBox: '0 0 24 24', xmlns: 'http://www.w3.org/2000/svg' }, [
        h('path', {
          d: 'M4 4h16v12H8l-4 4z',
          fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linejoin': 'round',
        }),
        h('path', { d: 'M8 9h8M8 12h5', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' }),
      ]),
  })
  ctx.page({
    path: '/feedback',
    name: '用户反馈',
    authority: 4,
    order: 87,
    icon: 'feedback',
    component: Page,
  })
}
