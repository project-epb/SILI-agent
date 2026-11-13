import { defineComponent, h, onMounted, ref, watch } from '../vue.js'
import { icons, send } from '../client.js'

function when(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function short(id) {
  if (!id) return '—'
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id
}
function badge(text, cls = '') {
  return h('span', { class: `qa-badge ${cls}` }, text)
}

const STATUS_OPTIONS = [
  ['all', '全部'],
  ['active', '已激活'],
  ['inactive', '未激活'],
]

/** Speakers of a group, or groups of a user (qqbot_member). */
const Members = defineComponent({
  props: { selfId: String, channelId: String, userId: String },
  setup(props) {
    const rows = ref(null)
    const err = ref('')
    onMounted(async () => {
      try {
        rows.value = await send('qqbot-admin/members', {
          selfId: props.selfId,
          channelId: props.channelId,
          userId: props.userId,
        })
      } catch (e) {
        err.value = String(e?.message ?? e)
      }
    })
    return () => {
      if (err.value) return h('p', { class: 'qa-err' }, err.value)
      if (!rows.value) return h('p', { class: 'qa-dim' }, '加载中…')
      if (!rows.value.length) return h('p', { class: 'qa-dim' }, '没有记录。')
      const byGroup = !!props.channelId
      return h('table', { class: 'qa-sub' }, [
        h('thead', h('tr', [
          h('th', byGroup ? '成员' : '群'),
          h('th', '首次'),
          h('th', '最近'),
          h('th', '发言数'),
        ])),
        h('tbody', rows.value.map((r) =>
          h('tr', { key: `${r.channelId}:${r.userId}` }, [
            h('td', byGroup
              ? [r.userName || '（无名称）', ' ', h('span', { class: 'qa-dim' }, short(r.userId))]
              : [r.channelName || '（未知群名）', ' ', h('span', { class: 'qa-dim' }, short(r.channelId))]),
            h('td', when(r.firstSeen)),
            h('td', when(r.lastSeen)),
            h('td', r.messageCount),
          ])
        )),
      ])
    }
  },
})

const Page = defineComponent({
  setup() {
    const tab = ref('groups')
    const status = ref('all')
    const q = ref('')
    const rows = ref([])
    const loading = ref(false)
    const err = ref('')
    const expanded = ref('')
    const busy = ref('')

    const load = async () => {
      loading.value = true
      err.value = ''
      try {
        rows.value = await send(
          tab.value === 'groups' ? 'qqbot-admin/groups' : 'qqbot-admin/users',
          { status: status.value, q: q.value }
        )
      } catch (e) {
        err.value = String(e?.message ?? e)
      } finally {
        loading.value = false
      }
    }
    onMounted(load)
    watch([tab, status], () => {
      expanded.value = ''
      load()
    })

    const act = async (key, event, payload) => {
      busy.value = key
      err.value = ''
      try {
        const res = await send(event, payload)
        if (res && res.ok === false && res.message) err.value = res.message
        await load()
      } catch (e) {
        err.value = String(e?.message ?? e)
      } finally {
        busy.value = ''
      }
    }

    const toolbar = () =>
      h('div', { class: 'qa-toolbar' }, [
        h('div', { class: 'qa-tabs' }, [
          ['groups', '群'],
          ['users', '用户 / 私聊'],
        ].map(([value, label]) =>
          h('button', {
            class: `qa-tab ${tab.value === value ? 'is-active' : ''}`,
            onClick: () => (tab.value = value),
          }, label)
        )),
        h('select', {
          class: 'qa-input',
          value: status.value,
          onChange: (e) => (status.value = e.target.value),
        }, STATUS_OPTIONS.map(([value, label]) => h('option', { value }, label))),
        h('input', {
          class: 'qa-input qa-search',
          placeholder: tab.value === 'groups' ? '群名或 openid' : '名称、openid 或账号',
          value: q.value,
          onInput: (e) => (q.value = e.target.value),
          onKeydown: (e) => e.key === 'Enter' && load(),
        }),
        h('button', { class: 'qa-btn', disabled: loading.value, onClick: load }, loading.value ? '加载中…' : '刷新'),
      ])

    const groupTable = () =>
      h('table', { class: 'qa-table' }, [
        h('thead', h('tr', [
          h('th', '群'),
          h('th', '成员'),
          h('th', '机器人'),
          h('th', '最近活跃'),
          h('th', '消息数'),
          h('th', '拉群人'),
          h('th', '迁移提示'),
          h('th', '操作'),
        ])),
        h('tbody', rows.value.flatMap((r) => {
          const key = `${r.selfId}:${r.id}`
          const main = h('tr', { key, class: r.active ? 'is-on' : '' }, [
            h('td', [
              h('div', r.name || '（未知群名）'),
              h('div', { class: 'qa-dim' }, short(r.id)),
              r.removedAt ? badge('已被移出', 'is-warn') : null,
              r.recvRejected ? badge('已关闭接收', 'is-warn') : null,
            ]),
            h('td', r.memberNum || '—'),
            h('td', [r.role || '—', ' ', h('span', { class: 'qa-dim' }, r.recvSetting || '')]),
            h('td', when(r.lastSeen)),
            h('td', r.messageCount),
            h('td', { class: 'qa-dim' }, short(r.addedBy)),
            h('td', r.noticeSentAt ? when(r.noticeSentAt) : r.noticePending ? badge('待发送') : '—'),
            h('td', { class: 'qa-actions' }, [
              h('button', {
                class: `qa-btn ${r.active ? 'is-danger' : ''}`,
                disabled: busy.value === key,
                onClick: () => act(key, 'qqbot-admin/toggle-group', { selfId: r.selfId, id: r.id, active: !r.active }),
              }, r.active ? '取消激活' : '激活'),
              h('button', {
                class: 'qa-btn is-plain',
                disabled: busy.value === key,
                onClick: () => act(key, 'qqbot-admin/refresh-group', { selfId: r.selfId, id: r.id }),
              }, '刷新信息'),
              h('button', {
                class: 'qa-btn is-plain',
                onClick: () => (expanded.value = expanded.value === key ? '' : key),
              }, expanded.value === key ? '收起' : '出现过的人'),
            ]),
          ])
          const detail = expanded.value === key
            ? h('tr', { key: key + ':m' }, h('td', { colspan: 8 }, h(Members, { selfId: r.selfId, channelId: r.id })))
            : null
          return [main, detail]
        })),
      ])

    const userTable = () =>
      h('table', { class: 'qa-table' }, [
        h('thead', h('tr', [
          h('th', '用户'),
          h('th', '绑定账号'),
          h('th', '最近活跃'),
          h('th', '消息数'),
          h('th', '私聊次数'),
          h('th', '操作'),
        ])),
        h('tbody', rows.value.flatMap((r) => {
          const key = `${r.selfId}:${r.id}`
          const served = r.isOp || r.dmActive
          const main = h('tr', { key, class: served ? 'is-on' : '' }, [
            h('td', [h('div', r.name || '（无名称）'), h('div', { class: 'qa-dim' }, short(r.id))]),
            h('td', r.account
              ? [r.account.name || '（未命名）', ' ', h('span', { class: 'qa-dim' }, `#${r.account.id}`), r.isOp ? badge('op') : null]
              : h('span', { class: 'qa-dim' }, '未绑定')),
            h('td', when(r.lastSeen)),
            h('td', r.messageCount),
            h('td', r.dmCount),
            h('td', { class: 'qa-actions' }, [
              h('button', {
                class: `qa-btn ${r.isOp ? 'is-danger' : 'is-plain'}`,
                disabled: busy.value === key,
                onClick: () => act(key, 'qqbot-admin/set-op', { id: r.id, op: !r.isOp }),
              }, r.isOp ? '取消 op' : '设为 op'),
              r.isOp
                ? h('span', { class: 'qa-dim' }, 'op 私聊始终放行')
                : h('button', {
                    class: `qa-btn ${r.dmActive ? 'is-danger' : ''}`,
                    disabled: busy.value === key,
                    onClick: () => act(key, 'qqbot-admin/toggle-dm', { selfId: r.selfId, id: r.id, active: !r.dmActive }),
                  }, r.dmActive ? '取消私聊激活' : '激活私聊'),
              h('button', {
                class: 'qa-btn is-plain',
                onClick: () => (expanded.value = expanded.value === key ? '' : key),
              }, expanded.value === key ? '收起' : '出现过的群'),
            ]),
          ])
          const detail = expanded.value === key
            ? h('tr', { key: key + ':m' }, h('td', { colspan: 6 }, h(Members, { selfId: r.selfId, userId: r.id })))
            : null
          return [main, detail]
        })),
      ])

    return () =>
      h('div', { class: 'qa-root' }, [
        h('p', { class: 'qa-notice' },
          '只记录元数据，不展示消息内容。成员只覆盖发过言的人，不是完整的群成员名单。激活群等同于在群里 assign。要让某人成为 op：先让他给机器人发一条消息（会被静默，但会出现在用户列表），再点「设为 op」。'),
        toolbar(),
        err.value ? h('p', { class: 'qa-err' }, err.value) : null,
        rows.value.length
          ? (tab.value === 'groups' ? groupTable() : userTable())
          : h('p', { class: 'qa-dim' }, loading.value ? '加载中…' : '没有记录。'),
      ])
  },
})

export default (ctx) => {
  // 侧栏图标：对话气泡加开关，区分于 LLM 的两个页面
  icons.register('qqbot-admin', {
    render: () =>
      h('svg', { viewBox: '0 0 24 24', fill: 'currentColor', xmlns: 'http://www.w3.org/2000/svg' }, [
        h('path', { d: 'M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z' }),
      ]),
  })
  ctx.page({
    path: '/qqbot-admin',
    name: 'QQ 频道管理',
    authority: 4,
    order: 88,
    icon: 'qqbot-admin',
    component: Page,
  })
}
