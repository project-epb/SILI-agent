import { defineComponent, h, onBeforeUnmount, onMounted, reactive, ref, resolveComponent, watch } from '../vue.js'
import { icons, receive, send } from '../client.js'

/** Console page for SILI's Linux machine: terminal, files, status. */

const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString('sv') : '—')
const fmtSize = (n) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KiB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MiB` : `${(n / 1024 ** 3).toFixed(2)} GiB`
const errText = (e) => e?.message ?? String(e)
const joinPath = (dir, name) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`)
const parentOf = (p) => p.replace(/\/[^/]+\/?$/, '') || '/'

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
const fileToB64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '')
    reader.onerror = reject
    reader.readAsDataURL(file)
  })

// Terminal output arrives as pushes; one dispatcher, routed by termId.
const termSinks = new Map()
receive('linux-admin/term', (body) => termSinks.get(body.termId)?.(body))

let xtermLoaded
const loadXterm = () =>
  (xtermLoaded ??= (async () => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = new URL('./vendor/xterm.css', import.meta.url).href
    document.head.appendChild(link)
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('./vendor/xterm.mjs'),
      import('./vendor/addon-fit.mjs'),
    ])
    return { Terminal, FitAddon }
  })())

const TerminalView = defineComponent({
  props: { root: Boolean },
  setup(props) {
    const el = ref(null)
    const state = ref('connecting')
    const error = ref('')
    let term, fit, termId, observer

    const close = () => {
      if (termId) {
        termSinks.delete(termId)
        send('linux-admin/term-close', { termId }).catch(() => {})
      }
      termId = undefined
    }

    const open = async () => {
      close()
      error.value = ''
      state.value = 'connecting'
      term.reset()
      try {
        const res = await send('linux-admin/term-open', { root: props.root, cols: term.cols, rows: term.rows })
        termId = res.termId
        const id = termId
        termSinks.set(id, (body) => {
          if (body.data) term.write(b64ToBytes(body.data))
          if (body.ended) {
            termSinks.delete(id)
            if (termId === id) termId = undefined
            state.value = 'ended'
            term.write(`\r\n\x1b[2m[shell 已退出${body.exitCode == null ? '' : `，退出码 ${body.exitCode}`}${body.error ? `：${body.error}` : ''}]\x1b[0m\r\n`)
          }
        })
        state.value = 'open'
        term.focus()
      } catch (e) {
        state.value = 'ended'
        error.value = errText(e)
      }
    }

    onMounted(async () => {
      const { Terminal, FitAddon } = await loadXterm()
      term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', scrollback: 5000 })
      fit = new FitAddon()
      term.loadAddon(fit)
      term.open(el.value)
      fit.fit()
      term.onData((data) => termId && send('linux-admin/term-input', { termId, data }).catch(() => {}))
      term.onResize(({ cols, rows }) => termId && send('linux-admin/term-resize', { termId, cols, rows }).catch(() => {}))
      observer = new ResizeObserver(() => {
        try {
          fit.fit()
        } catch {}
      })
      observer.observe(el.value)
      await open()
    })
    onBeforeUnmount(() => {
      observer?.disconnect()
      close()
      term?.dispose()
    })
    watch(() => props.root, () => term && open())

    return () =>
      h('div', { class: 'lx-term-wrap' }, [
        h('div', { class: 'lx-bar' }, [
          h('span', { class: 'lx-dim' }, `${props.root ? 'root' : 'user'} · ${{ connecting: '连接中…', open: '已连接', ended: '已结束' }[state.value]}`),
          h('button', { class: 'lx-btn', onClick: open }, '新终端'),
          error.value ? h('span', { class: 'lx-err' }, error.value) : null,
        ]),
        h('div', { class: 'lx-term', ref: el }),
      ])
  },
})

const FilesView = defineComponent({
  props: { root: Boolean },
  setup(props) {
    const path = ref('/home/user')
    const input = ref('/home/user')
    const entries = ref([])
    const err = ref('')
    const busy = ref('')
    const newDir = ref('')
    const editing = reactive({ path: '', text: '', saving: false })

    const call = async (label, fn) => {
      err.value = ''
      busy.value = label
      try {
        return await fn()
      } catch (e) {
        err.value = errText(e)
      } finally {
        busy.value = ''
      }
    }
    const load = (p = path.value) =>
      call('读取中…', async () => {
        const res = await send('linux-admin/fs-list', { path: p, root: props.root })
        path.value = input.value = res.path
        entries.value = res.entries
      })

    const download = (e) =>
      call(`下载 ${e.name}…`, async () => {
        const { base64 } = await send('linux-admin/fs-read', { path: joinPath(path.value, e.name), root: props.root })
        const url = URL.createObjectURL(new Blob([b64ToBytes(base64)]))
        const a = document.createElement('a')
        a.href = url
        a.download = e.name
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 10_000)
      })
    const edit = (e) =>
      call(`打开 ${e.name}…`, async () => {
        const file = joinPath(path.value, e.name)
        const { text } = await send('linux-admin/fs-read', { path: file, root: props.root, text: true })
        Object.assign(editing, { path: file, text, saving: false })
      })
    const save = () =>
      call('保存中…', async () => {
        await send('linux-admin/fs-write', { path: editing.path, text: editing.text, root: props.root })
        editing.path = ''
        await load()
      })
    const remove = (e) => {
      const file = joinPath(path.value, e.name)
      if (!confirm(`删除 ${file}${e.type === 'dir' ? ' 及其全部内容' : ''}？`)) return
      call('删除中…', async () => {
        await send('linux-admin/fs-delete', { path: file, root: props.root })
        await load()
      })
    }
    const mkdir = () => {
      const name = newDir.value.trim()
      if (!name) return
      call('创建中…', async () => {
        await send('linux-admin/fs-mkdir', { path: name.startsWith('/') ? name : joinPath(path.value, name), root: props.root })
        newDir.value = ''
        await load()
      })
    }
    const upload = (ev) => {
      const files = [...(ev.target.files ?? [])]
      ev.target.value = ''
      call('上传中…', async () => {
        for (const file of files) {
          if (file.size > 50 * 1024 * 1024) throw new Error(`${file.name} 超过 50 MiB`)
          busy.value = `上传 ${file.name}…`
          await send('linux-admin/fs-write', { path: joinPath(path.value, file.name), base64: await fileToB64(file), root: props.root })
        }
        await load()
      })
    }

    onMounted(() => load())
    watch(() => props.root, () => load())

    const row = (e) =>
      h('tr', { key: e.name }, [
        h('td', [
          e.type === 'dir'
            ? h('a', { class: 'lx-link', onClick: () => load(joinPath(path.value, e.name)) }, `${e.name}/`)
            : h('span', e.type === 'link' ? `${e.name} →` : e.name),
        ]),
        h('td', { class: 'lx-dim' }, e.type === 'dir' ? '' : fmtSize(e.size)),
        h('td', { class: 'lx-dim' }, fmtTime(e.mtime)),
        h('td', { class: 'lx-actions' }, [
          e.type === 'file' ? h('button', { class: 'lx-btn lx-small', onClick: () => download(e) }, '下载') : null,
          e.type === 'file' && e.size <= 1024 * 1024 ? h('button', { class: 'lx-btn lx-small', onClick: () => edit(e) }, '编辑') : null,
          h('button', { class: 'lx-btn lx-small lx-danger', onClick: () => remove(e) }, '删除'),
        ]),
      ])

    return () =>
      h('div', { class: 'lx-files' }, [
        h('div', { class: 'lx-bar' }, [
          h('button', { class: 'lx-btn', onClick: () => load(parentOf(path.value)) }, '上一级'),
          h('input', {
            class: 'lx-input',
            value: input.value,
            onInput: (e) => (input.value = e.target.value),
            onKeydown: (e) => e.key === 'Enter' && load(input.value),
          }),
          h('button', { class: 'lx-btn', onClick: () => load(input.value) }, '前往'),
          h('label', { class: 'lx-btn' }, ['上传', h('input', { type: 'file', multiple: true, hidden: true, onChange: upload })]),
          h('input', { class: 'lx-input lx-narrow', placeholder: '新目录名', value: newDir.value, onInput: (e) => (newDir.value = e.target.value) }),
          h('button', { class: 'lx-btn', onClick: mkdir }, '新建目录'),
        ]),
        busy.value ? h('p', { class: 'lx-dim' }, busy.value) : null,
        err.value ? h('p', { class: 'lx-err' }, err.value) : null,
        editing.path
          ? h('div', { class: 'lx-editor' }, [
              h('div', { class: 'lx-bar' }, [
                h('code', editing.path),
                h('button', { class: 'lx-btn', onClick: save }, '保存'),
                h('button', { class: 'lx-btn lx-ghost', onClick: () => (editing.path = '') }, '关闭'),
              ]),
              h('textarea', { class: 'lx-textarea', value: editing.text, spellcheck: false, onInput: (e) => (editing.text = e.target.value) }),
            ])
          : null,
        h('table', { class: 'lx-table' }, [
          h('thead', h('tr', [h('th', '名称'), h('th', '大小'), h('th', '修改时间'), h('th', '')])),
          h('tbody', entries.value.length ? entries.value.map(row) : h('tr', h('td', { class: 'lx-dim', colspan: 4 }, '空目录'))),
        ]),
      ])
  },
})

const StatusView = defineComponent({
  setup() {
    const status = ref(null)
    const err = ref('')
    const busy = ref('')
    const call = async (label, fn) => {
      err.value = ''
      busy.value = label
      try {
        return await fn()
      } catch (e) {
        err.value = errText(e)
      } finally {
        busy.value = ''
      }
    }
    const load = () => call('读取中…', async () => (status.value = await send('linux-admin/status')))
    const restart = () => confirm('重启 Linux 机器？正在跑的命令和后台任务都会被中断。') && call('重启中…', async () => (await send('linux-admin/restart'), await load()))
    const backup = () => call('备份中…', async () => (await send('linux-admin/backup'), await load()))
    const kill = (job) => confirm(`结束 ${job.id}？`) && call('结束中…', async () => (await send('linux-admin/job-kill', { pid: job.pid }), await load()))
    onMounted(load)

    const backupLine = (b) =>
      !b
        ? '本次进程还没有备份过'
        : b.result.status === 'done'
          ? `${fmtTime(new Date(b.at).getTime())}，${fmtSize(b.result.bytes)}`
          : `${fmtTime(new Date(b.at).getTime())} ${b.result.status === 'skipped' ? '跳过' : '失败'}：${b.result.reason}`

    return () => {
      const s = status.value
      return h('div', { class: 'lx-status' }, [
        h('div', { class: 'lx-bar' }, [
          h('button', { class: 'lx-btn', onClick: load }, '刷新'),
          h('button', { class: 'lx-btn', onClick: backup }, '立即备份'),
          h('button', { class: 'lx-btn lx-danger', onClick: restart }, '重启机器'),
          busy.value ? h('span', { class: 'lx-dim' }, busy.value) : null,
        ]),
        err.value ? h('p', { class: 'lx-err' }, err.value) : null,
        s
          ? h('dl', { class: 'lx-dl' }, [
              h('dt', '状态'), h('dd', s.running ? `运行中，启动于 ${fmtTime(s.bootedAt)}` : '未启动（用到时自动启动）'),
              s.running ? [h('dt', '磁盘'), h('dd', h('code', s.df))] : null,
              s.running ? [h('dt', '内存'), h('dd', s.mem)] : null,
              h('dt', '上次备份'), h('dd', backupLine(s.backup)),
            ])
          : null,
        s?.running
          ? h('table', { class: 'lx-table' }, [
              h('thead', h('tr', [h('th', '后台任务'), h('th', '命令'), h('th', '开始'), h('th', '状态'), h('th', '')])),
              h('tbody', s.jobs.length
                ? s.jobs.map((j) =>
                    h('tr', { key: j.id }, [
                      h('td', h('code', j.id)),
                      h('td', h('code', { class: 'lx-cmd' }, j.command)),
                      h('td', { class: 'lx-dim' }, fmtTime(j.startedAt)),
                      h('td', j.running ? '运行中' : j.exitCode == null ? '被终止' : `退出码 ${j.exitCode}`),
                      h('td', j.running && j.pid ? h('button', { class: 'lx-btn lx-small lx-danger', onClick: () => kill(j) }, '结束') : null),
                    ]))
                : h('tr', h('td', { class: 'lx-dim', colspan: 5 }, '没有后台任务'))),
            ])
          : null,
      ])
    }
  },
})

const TABS = [
  ['term', '终端'],
  ['files', '文件'],
  ['status', '状态'],
]

const Page = defineComponent({
  setup() {
    const tab = ref('term')
    const root = ref(false)
    return () => {
      const KLayout = resolveComponent('k-layout')
      return h(KLayout, {}, {
        default: () =>
          h('div', { class: 'lx-root' }, [
            h('div', { class: 'lx-tabs' }, [
              ...TABS.map(([key, label]) =>
                h('button', { class: ['lx-tab', tab.value === key && 'lx-active'], onClick: () => (tab.value = key) }, label)),
              h('label', { class: 'lx-rootsw' }, [
                h('input', { type: 'checkbox', checked: root.value, onChange: (e) => (root.value = e.target.checked) }),
                ' 以 root 身份',
              ]),
            ]),
            // The terminal stays mounted across tabs, so switching keeps the shell.
            h('div', { class: 'lx-pane', style: { display: tab.value === 'term' ? '' : 'none' } }, h(TerminalView, { root: root.value })),
            tab.value === 'files' ? h('div', { class: 'lx-pane lx-scroll' }, h(FilesView, { root: root.value })) : null,
            tab.value === 'status' ? h('div', { class: 'lx-pane lx-scroll' }, h(StatusView)) : null,
          ]),
      })
    }
  },
})

export default (ctx) => {
  icons.register('linux-admin', {
    render: () =>
      h('svg', { viewBox: '0 0 24 24', xmlns: 'http://www.w3.org/2000/svg', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [
        h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }),
        h('path', { d: 'M7 9l3 3-3 3' }),
        h('path', { d: 'M13 15h4' }),
      ]),
  })
  ctx.page({
    path: '/linux-admin',
    name: 'Linux 机器',
    authority: 4,
    order: 86,
    icon: 'linux-admin',
    component: Page,
  })
}
