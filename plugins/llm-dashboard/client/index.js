import { defineComponent, h, onMounted, ref } from '../vue.js'
import { send } from '../client.js'

const Dashboard = defineComponent({
  name: 'LlmDashboard',
  setup() {
    const stats = ref(null)
    const loading = ref(false)
    const error = ref('')

    async function load(range = 30) {
      loading.value = true
      error.value = ''
      try {
        stats.value = await send('llm-dashboard/stats', { range })
      } catch (err) {
        error.value = err?.message ?? String(err)
      } finally {
        loading.value = false
      }
    }

    onMounted(() => load())

    return () => {
      const s = stats.value
      const body = error.value
        ? h('p', { style: 'color:var(--k-color-danger,#e05)' }, '加载失败：' + error.value)
        : !s
          ? h('p', loading.value ? '加载中…' : '（无数据）')
          : h('pre', { style: 'white-space:pre-wrap' }, JSON.stringify(s.overview, null, 2))
      return h('k-layout', null, {
        default: () => h('k-card', { style: 'margin:1.5rem' }, { default: () => body }),
      })
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
