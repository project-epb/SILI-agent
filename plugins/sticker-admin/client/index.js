import { defineComponent, h, onMounted, reactive, ref, resolveComponent } from '../vue.js'
import { icons, send } from '../client.js'

const STATUS_TABS = [
  ['active', '启用'],
  ['disabled', '已禁用'],
  ['rejected', '非表情包'],
  ['candidate', '候选'],
]
const SOURCES = [
  ['', '全部来源'],
  ['harvest', '群聊收集'],
  ['upload', '后台上传'],
  ['qface', 'QQ 表情'],
  ['own', '人设专属'],
]

const readAsDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })

/** One sticker: picture, tag chips (first = primary), desc, usage, save / disable. */
const Card = defineComponent({
  props: { row: Object, types: Array, onChanged: Function },
  setup(props) {
    const draft = reactive({ tags: [...props.row.tags], desc: props.row.desc, usage: props.row.usage })
    const busy = ref(false)
    const msg = ref('')
    const dirty = () =>
      draft.desc !== props.row.desc ||
      draft.usage !== props.row.usage ||
      draft.tags.join() !== props.row.tags.join()

    const toggleTag = (t) => {
      const i = draft.tags.indexOf(t)
      if (i >= 0) draft.tags.splice(i, 1)
      else if (draft.tags.length < 3) draft.tags.push(t)
    }
    const call = async (patch) => {
      busy.value = true
      msg.value = ''
      try {
        await send('sticker-admin/update', { id: props.row.id, ...patch })
        Object.assign(props.row, patch)
        msg.value = '已保存'
        props.onChanged?.()
      } catch (e) {
        msg.value = e?.message ?? String(e)
      } finally {
        busy.value = false
      }
    }

    return () => {
      const r = props.row
      const editable = r.status === 'active' || r.status === 'disabled'
      return h('div', { class: ['sa-card', r.status !== 'active' ? 'is-off' : ''] }, [
        h('div', { class: 'sa-thumb' }, r.url ? h('img', { src: r.url, loading: 'lazy' }) : h('span', { class: 'sa-dim' }, '未下载')),
        h('div', { class: 'sa-meta' }, [
          h('span', r.name ? `#${r.id} · ${r.owner}「${r.name}」` : `#${r.id}`),
          h('span', `收到 ${r.seenCount} 次 · ${r.seenUsers} 人`),
          h('span', `发过 ${r.sentCount} 次`),
        ]),
        editable
          ? h('div', { class: 'sa-tags' }, props.types.map((t) => {
              const i = draft.tags.indexOf(t)
              return h('button', {
                class: ['sa-chip', i === 0 ? 'is-primary' : i > 0 ? 'is-on' : ''],
                title: i === 0 ? '主标签：随机发表情时按它挑' : '',
                onClick: () => toggleTag(t),
              }, t)
            }))
          : null,
        editable
          ? [
              h('input', { class: 'sa-input', placeholder: '画面描述', value: draft.desc, onInput: (e) => (draft.desc = e.target.value) }),
              h('input', { class: 'sa-input', placeholder: '用法（可选，群里怎么用它）', value: draft.usage, onInput: (e) => (draft.usage = e.target.value) }),
              h('div', { class: 'sa-actions' }, [
                h('button', {
                  class: 'sa-btn is-primary',
                  disabled: busy.value || !dirty() || !draft.tags.length,
                  onClick: () => call({ tags: [...draft.tags], desc: draft.desc.trim(), usage: draft.usage.trim() }),
                }, '保存'),
                h('button', {
                  class: ['sa-btn', r.status === 'active' ? 'is-danger' : ''],
                  disabled: busy.value,
                  onClick: () => call({ status: r.status === 'active' ? 'disabled' : 'active' }),
                }, r.status === 'active' ? '禁用' : '启用'),
                msg.value ? h('span', { class: 'sa-dim' }, msg.value) : null,
              ]),
            ]
          : h('div', { class: 'sa-dim' }, r.desc || '—'),
      ])
    }
  },
})

const Page = defineComponent({
  setup() {
    const overview = ref(null)
    const rows = ref([])
    const total = ref(0)
    const filter = reactive({ status: 'active', source: '', tag: '', q: '', page: 1 })
    const err = ref('')
    const uploading = ref('')
    const limits = reactive({ dailyMaxStickers: 0, dailyMaxTokens: 0 })

    const loadOverview = async () => {
      overview.value = await send('sticker-admin/overview')
      Object.assign(limits, {
        dailyMaxStickers: overview.value.settings.dailyMaxStickers,
        dailyMaxTokens: overview.value.settings.dailyMaxTokens,
      })
    }
    const load = async (page = 1) => {
      err.value = ''
      try {
        filter.page = page
        const res = await send('sticker-admin/list', { ...filter })
        rows.value = res.rows
        total.value = res.total
      } catch (e) {
        err.value = e?.message ?? String(e)
      }
    }
    const saveSettings = async (patch) => {
      try {
        overview.value.settings = await send('sticker-admin/settings', patch)
      } catch (e) {
        err.value = e?.message ?? String(e)
      }
    }
    const upload = async (e) => {
      const files = [...e.target.files]
      e.target.value = ''
      for (const [i, file] of files.entries()) {
        uploading.value = `上传并识图中 ${i + 1}/${files.length}…`
        try {
          await send('sticker-admin/upload', { dataUrl: await readAsDataUrl(file) })
        } catch (e) {
          err.value = `${file.name}: ${e?.message ?? e}`
        }
      }
      uploading.value = ''
      await Promise.all([loadOverview(), load(1)])
    }
    onMounted(() => Promise.all([loadOverview(), load(1)]).catch((e) => (err.value = e?.message ?? String(e))))

    const settingsPanel = () => {
      const o = overview.value
      if (!o) return null
      const s = o.settings
      return h('div', { class: 'sa-panel' }, [
        h('label', { class: 'sa-switch' }, [
          h('input', { type: 'checkbox', checked: s.enabled, onChange: (e) => saveSettings({ enabled: e.target.checked }) }),
          ' 从群聊自动收集表情',
        ]),
        h('label', ['每日最多入库 ', h('input', {
          class: 'sa-input sa-num', type: 'number', min: 0, value: limits.dailyMaxStickers,
          onChange: (e) => saveSettings({ dailyMaxStickers: e.target.value }),
        }), ' 张']),
        h('label', ['每日识图最多 ', h('input', {
          class: 'sa-input sa-num', type: 'number', min: 0, step: 1000, value: limits.dailyMaxTokens,
          onChange: (e) => saveSettings({ dailyMaxTokens: e.target.value }),
        }), ' token']),
        h('span', { class: 'sa-dim' }, `今天：入库 ${o.usage.stickers} 张，识图 ${o.usage.tokens} token`),
      ])
    }

    const toolbar = () =>
      h('div', { class: 'sa-toolbar' }, [
        h('div', { class: 'sa-tabs' }, STATUS_TABS.map(([v, label]) =>
          h('button', {
            class: ['sa-tab', filter.status === v ? 'is-active' : ''],
            onClick: () => { filter.status = v; load(1) },
          }, `${label} ${overview.value?.counts?.[v] ?? 0}`))),
        h('select', { class: 'sa-input', value: filter.source, onChange: (e) => { filter.source = e.target.value; load(1) } },
          SOURCES.map(([v, label]) => h('option', { value: v }, label))),
        h('select', { class: 'sa-input', value: filter.tag, onChange: (e) => { filter.tag = e.target.value; load(1) } },
          [h('option', { value: '' }, '全部类型'), ...Object.keys(overview.value?.types ?? {}).map((t) => h('option', { value: t }, t))]),
        h('input', {
          class: 'sa-input sa-search', placeholder: '搜描述或用法', value: filter.q,
          onInput: (e) => (filter.q = e.target.value), onKeydown: (e) => e.key === 'Enter' && load(1),
        }),
        h('label', { class: 'sa-btn is-primary' }, [
          uploading.value || '上传表情',
          h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, disabled: !!uploading.value, onChange: upload }),
        ]),
      ])

    const pager = () => {
      const pages = Math.ceil(total.value / 60)
      if (pages <= 1) return null
      return h('div', { class: 'sa-pager' }, [
        h('button', { class: 'sa-btn', disabled: filter.page <= 1, onClick: () => load(filter.page - 1) }, '上一页'),
        h('span', { class: 'sa-dim' }, `${filter.page} / ${pages}`),
        h('button', { class: 'sa-btn', disabled: filter.page >= pages, onClick: () => load(filter.page + 1) }, '下一页'),
      ])
    }

    return () => {
      const KLayout = resolveComponent('k-layout')
      const types = Object.keys(overview.value?.types ?? {})
      return h(KLayout, null, {
        default: () => h('div', { class: 'sa-root' }, [
          settingsPanel(),
          toolbar(),
          h('ul', { class: 'sa-notice' }, [
            h('li', '高亮的第一个标签是主标签：SILI 按类型随机发表情时只看主标签。'),
            h('li', '「用法」写群里约定俗成的意思（比如反讽），SILI 读到表情时会看到它。'),
            h('li', '表情不能删除，只能禁用：删掉的话，下次在群里出现又会被重新收集。'),
          ]),
          err.value ? h('p', { class: 'sa-err' }, err.value) : null,
          rows.value.length
            ? h('div', { class: 'sa-grid' }, rows.value.map((r) =>
                h(Card, { key: `${r.id}:${filter.status}`, row: r, types, onChanged: loadOverview })))
            : h('p', { class: 'sa-dim sa-empty' }, '没有记录。'),
          pager(),
        ]),
      })
    }
  },
})

export default (ctx) => {
  icons.register('sticker-admin', {
    render: () =>
      h('svg', { viewBox: '0 0 24 24', xmlns: 'http://www.w3.org/2000/svg', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' }, [
        h('path', { d: 'M15 3H8a5 5 0 0 0-5 5v8a5 5 0 0 0 5 5h5l8-8V8a5 5 0 0 0-5-5z' }),
        h('path', { d: 'M13 21v-3a5 5 0 0 1 5-5h3' }),
        h('circle', { cx: 9, cy: 10, r: 0.8, fill: 'currentColor' }),
        h('circle', { cx: 14, cy: 10, r: 0.8, fill: 'currentColor' }),
        h('path', { d: 'M8.5 14.5c1.5 1.3 3.5 1.3 5 0' }),
      ]),
  })
  ctx.page({
    path: '/sticker-admin',
    name: '表情库',
    authority: 4,
    order: 87,
    icon: 'sticker-admin',
    component: Page,
  })
}
