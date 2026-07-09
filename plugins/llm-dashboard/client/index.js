// Hand-written browser ESM entry — NO build step.
// `../vue.js` and `../client.js` are pseudo-packages the console serves at its
// uiPath root (shared single Vue instance + @koishijs/client runtime). This file
// is loaded verbatim by the console via `import(entryUrl)`; its default export is
// invoked as a client plugin `(ctx) => {}`.
import { defineComponent, h, ref, resolveComponent } from '../vue.js'
import { send } from '../client.js'

const BTN =
  'padding:.4rem 1rem;border-radius:6px;border:1px solid var(--k-color-border,#d0d0d0);background:var(--k-card-bg,#fff);cursor:pointer;font-size:.95rem'

const Dashboard = defineComponent({
  name: 'LlmDashboardSpike',
  setup() {
    const count = ref(0)
    const serverMsg = ref('（尚未请求）')
    const loading = ref(false)

    async function ping() {
      loading.value = true
      try {
        const res = await send('llm-dashboard/ping')
        serverMsg.value = `${res.message} @ ${new Date(res.time).toLocaleTimeString()}`
      } catch (err) {
        serverMsg.value = '请求失败：' + (err?.message ?? String(err))
      } finally {
        loading.value = false
      }
    }

    return () => {
      const KLayout = resolveComponent('k-layout')
      const KCard = resolveComponent('k-card')
      return h(KLayout, null, {
        default: () =>
          h(
            KCard,
            { style: 'margin:2rem;max-width:640px' },
            {
              default: () => [
                h(
                  'h1',
                  { style: 'margin:0 0 .5rem;font-size:1.5rem' },
                  'Hello, LLM Dashboard 👋'
                ),
                h(
                  'p',
                  { style: 'color:var(--k-text-light,#888)' },
                  '可行性验证页：手写 ESM，无前端构建。'
                ),
                h(
                  'div',
                  {
                    style:
                      'margin:1.5rem 0;display:flex;align-items:center;gap:1rem',
                  },
                  [
                    h('button', { style: BTN, onClick: () => count.value++ }, '+1'),
                    h(
                      'span',
                      { style: 'font-size:1.2rem' },
                      `计数：${count.value}`
                    ),
                  ]
                ),
                h('hr', {
                  style:
                    'border:none;border-top:1px solid var(--k-color-border,#eee);margin:1.5rem 0',
                }),
                h(
                  'div',
                  {
                    style:
                      'display:flex;flex-direction:column;gap:.75rem;align-items:flex-start',
                  },
                  [
                    h(
                      'button',
                      { style: BTN, disabled: loading.value, onClick: ping },
                      loading.value ? '请求中…' : '请求后端 (send)'
                    ),
                    h('span', `后端返回：${serverMsg.value}`),
                  ]
                ),
              ],
            }
          ),
      })
    }
  },
})

export default (ctx) => {
  ctx.page({
    path: '/llm-dashboard',
    name: 'LLM 用量',
    order: 100,
    component: Dashboard,
  })
}
