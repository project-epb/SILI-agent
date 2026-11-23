import { send } from '../client.js'
import { defineComponent, h, onMounted, onUnmounted, ref } from '../vue.js'

const PAGE_SIZE = 30
const roleNames = { owner: '群主', admin: '管理员', member: '成员' }

export const ChatMembers = defineComponent({
  props: { chat: Object },
  emits: ['user'],
  setup(props, { emit }) {
    const query = ref('')
    const rows = ref([])
    const page = ref(1)
    const total = ref(0)
    const busy = ref(true)
    const error = ref('')
    let request = 0
    let timer

    async function load(nextPage) {
      const current = ++request
      busy.value = true
      error.value = ''
      try {
        const result = await send('qqbot-admin/members', {
          selfId: props.chat.selfId,
          channelId: props.chat.channelId,
          q: query.value,
          page: nextPage,
          pageSize: PAGE_SIZE,
        })
        if (current !== request) return
        rows.value = result.rows
        page.value = nextPage
        total.value = result.total
      } catch (cause) {
        if (current === request) error.value = String(cause?.message ?? cause)
      } finally {
        if (current === request) busy.value = false
      }
    }

    onMounted(() => load(1))
    onUnmounted(() => {
      clearTimeout(timer)
      request++
    })
    return () =>
      h('div', { class: 'qc-members' }, [
        h('input', {
          type: 'search',
          'aria-label': '搜索已记录成员',
          placeholder: '搜索名字或 OpenID',
          value: query.value,
          onInput: (event) => {
            query.value = event.target.value
            busy.value = true
            request++
            clearTimeout(timer)
            timer = setTimeout(() => load(1), 200)
          },
        }),
        busy.value
          ? h('p', { role: 'status' }, '正在加载成员…')
          : error.value
            ? h('p', { role: 'alert', class: 'qc-error' }, error.value)
            : !rows.value.length
              ? h('p', '没有匹配的已记录成员。')
              : h(
                  'ul',
                  rows.value.map((row) =>
                    h(
                      'li',
                      { key: row.userId },
                      h(
                        'button',
                        { type: 'button', onClick: () => emit('user', row) },
                        [
                          h('strong', [
                            row.userName || row.userId,
                            row.isBot === true
                              ? h('small', { class: 'qc-member-tag' }, '机器人')
                              : null,
                            roleNames[row.role]
                              ? h(
                                  'small',
                                  {
                                    class: 'qc-member-tag',
                                    title: row.roleSeenAt
                                      ? `群角色记录于 ${new Date(row.roleSeenAt).toLocaleString('zh-CN')}`
                                      : undefined,
                                  },
                                  roleNames[row.role]
                                )
                              : null,
                          ]),
                          h('small', row.userId),
                          h('span', `${row.messageCount} 条`),
                        ]
                      )
                    )
                  )
                ),
        total.value > PAGE_SIZE
          ? h('div', { class: 'qc-pager' }, [
              h(
                'button',
                {
                  type: 'button',
                  disabled: busy.value || page.value <= 1,
                  onClick: () => load(page.value - 1),
                },
                '上一页'
              ),
              h(
                'span',
                `${page.value} / ${Math.ceil(total.value / PAGE_SIZE)}`
              ),
              h(
                'button',
                {
                  type: 'button',
                  disabled: busy.value || page.value * PAGE_SIZE >= total.value,
                  onClick: () => load(page.value + 1),
                },
                '下一页'
              ),
            ])
          : null,
      ])
  },
})

export const ChatSettings = defineComponent({
  props: { target: Object, features: Object },
  setup(props) {
    const details = ref(null)
    const error = ref('')
    const busy = ref(true)
    const version = ref(0)

    async function load() {
      const { kind, id, selfId } = props.target
      const result = await send(
        kind === 'group' ? 'qqbot-admin/groups' : 'qqbot-admin/users',
        {
          id,
          selfId,
          pageSize: 1,
        }
      )
      details.value = result.rows[0] ?? null
    }

    async function update(event, args) {
      busy.value = true
      error.value = ''
      try {
        if (event) {
          const result = await send(event, args)
          if (!result.ok) throw new Error(result.message)
        }
        await load()
        if (event) version.value++
      } catch (cause) {
        error.value = String(cause?.message ?? cause)
      } finally {
        busy.value = false
      }
    }

    onMounted(() => update())

    return () => {
      const row = details.value
      const { id, selfId, kind } = props.target
      const group = kind === 'group'
      const active = group ? row?.active : row?.dmActive || row?.isOp
      return h('div', { class: 'qc-settings' }, [
        h('div', { class: 'qc-identity' }, [
          h(
            'strong',
            row?.name || props.target.name || (group ? 'QQ群' : 'QQ 用户')
          ),
          h('code', id),
        ]),
        error.value
          ? h('p', { class: 'qc-error', role: 'alert' }, error.value)
          : null,
        row
          ? h('div', { class: 'qc-settings-card' }, [
              h('div', { class: 'qc-setting-line' }, [
                h('div', [
                  h('strong', group ? '群服务' : '私聊服务'),
                  h(
                    'small',
                    row.isOp ? '管理员始终启用' : active ? '已激活' : '未激活'
                  ),
                ]),
                !row.isOp
                  ? h(
                      'button',
                      {
                        type: 'button',
                        disabled: busy.value,
                        onClick: () =>
                          update(
                            group
                              ? 'qqbot-admin/toggle-group'
                              : 'qqbot-admin/toggle-dm',
                            { selfId, id, active: !active }
                          ),
                      },
                      active ? '取消激活' : '激活'
                    )
                  : null,
              ]),
              group
                ? h('div', { class: 'qc-setting-line' }, [
                    h('div', [
                      h('strong', 'QQ 主动发送'),
                      h('small', row.allowProactive ? '群已授权' : '群未授权'),
                    ]),
                    h(
                      'button',
                      {
                        type: 'button',
                        disabled: busy.value,
                        onClick: () =>
                          update('qqbot-admin/refresh-group', { selfId, id }),
                      },
                      '刷新群信息'
                    ),
                  ])
                : h('label', { class: 'qc-setting-line' }, [
                    h('div', [
                      h('strong', 'Koishi 权限'),
                      h(
                        'small',
                        row.account?.name ||
                          (row.account ? '已绑定账号' : '未绑定账号')
                      ),
                    ]),
                    h(
                      'select',
                      {
                        disabled: busy.value,
                        value: String(row.account?.authority ?? ''),
                        onChange: (event) => {
                          const authority = Number(event.target.value)
                          event.target.value = String(
                            row.account?.authority ?? ''
                          )
                          void update('qqbot-admin/set-authority', {
                            id,
                            authority,
                          })
                        },
                      },
                      [
                        row.account
                          ? null
                          : h(
                              'option',
                              { value: '', disabled: true },
                              '无账号'
                            ),
                        ...[0, 1, 2, 3, 4, 5].map((level) =>
                          h('option', { value: String(level) }, String(level))
                        ),
                      ]
                    ),
                  ]),
            ])
          : h('p', busy.value ? '正在加载配置…' : '没有这个会话的配置记录。'),
        row
          ? h('section', { class: 'qc-features' }, [
              h('h3', '功能覆写'),
              h(props.features, { id, selfId, kind, key: version.value }),
            ])
          : null,
      ])
    }
  },
})
