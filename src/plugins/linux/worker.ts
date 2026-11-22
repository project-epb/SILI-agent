/**
 * The Linux VM, in a thread of its own so guest computation never blocks
 * the bot's event loop. Inline mode here, not unkernel's `worker: true`:
 * that mode accepts only its built-in network backends, and the guest must
 * get the filtered one. Bun only: unkernel needs JSPI, which Node 24 lacks.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parentPort } from 'node:worker_threads'

import {
  bundledBoot,
  createImageFromKwsparse,
  createKernel,
  fetchDistro,
  openDisk,
  type Pty,
} from 'unkernel/node'

import { filteredBackend } from './net-backend'
import type { BootOptions, HostMessage, WorkerMessage } from './protocol'

const port = parentPort!
const send = (msg: WorkerMessage, transfer: ArrayBuffer[] = []) =>
  port.postMessage(msg, transfer)

type Kernel = Awaited<ReturnType<typeof createKernel>>
let vm: Kernel | undefined
const running = new Map<number, AbortController>()

// Guest writes sit in its page cache until synced; a process that dies
// before then loses them. Sync shortly after every command.
const SYNC_DELAY_MS = 1000
let syncTimer: ReturnType<typeof setTimeout> | undefined
function scheduleSync() {
  clearTimeout(syncTimer)
  syncTimer = setTimeout(() => void vm?.sync().catch(() => {}), SYNC_DELAY_MS)
}

async function boot(opts: BootOptions) {
  mkdirSync(opts.dataDir, { recursive: true })
  const wasmPath = path.join(
    path.dirname(require.resolve('unkernel/node')),
    'unkernel.wasm'
  )
  const module = await WebAssembly.compile(await readFile(wasmPath))
  const dataPath = path.join(opts.dataDir, 'data.img')
  if (!existsSync(dataPath)) {
    const template = bundledBoot(module).datadisk
    if (!template) throw new Error('the kernel carries no data disk template')
    await createImageFromKwsparse(dataPath, template)
  }
  const distro = await fetchDistro('alpine', {
    cacheDir: path.join(opts.dataDir, 'cache'),
  })
  vm = await createKernel({
    kernel: module,
    distro,
    disks: [await openDisk(dataPath)],
    memoryMiB: opts.memoryMiB,
    net: filteredBackend(opts.proxy),
  })
  vm.exited.then((end) => send({ type: 'exited', reason: `${end.kind} ${end.code}` }))
}

async function exec(msg: Extract<HostMessage, { type: 'exec' }>) {
  if (!vm) return send({ type: 'error', id: msg.id, code: 'NOT_BOOTED', message: 'not booted' })
  const ac = new AbortController()
  running.set(msg.id, ac)
  const timer = msg.timeoutMs ? setTimeout(() => ac.abort('timeout'), msg.timeoutMs) : undefined
  try {
    const r = await vm.exec(msg.argv[0]!, msg.argv.slice(1), {
      input: msg.input,
      encoding: 'buffer',
      user: msg.user,
      maxBuffer: msg.maxBuffer,
      signal: ac.signal,
    })
    const stdout = new Uint8Array(r.stdout)
    const stderr = new Uint8Array(r.stderr)
    send(
      { type: 'result', id: msg.id, stdout, stderr, exitCode: r.exitCode, signal: r.signal },
      [stdout.buffer, stderr.buffer]
    )
  } catch (e: any) {
    const code = ac.signal.aborted ? (ac.signal.reason === 'timeout' ? 'TIMEOUT' : 'ABORTED') : (e?.code ?? 'ERROR')
    send({ type: 'error', id: msg.id, code, message: String(e?.message ?? e) })
  } finally {
    clearTimeout(timer)
    running.delete(msg.id)
    scheduleSync()
  }
}

const ptys = new Map<number, Pty>()

async function openPty(msg: Extract<HostMessage, { type: 'pty-open' }>) {
  if (!vm) return send({ type: 'pty-ended', id: msg.id, exitCode: null, error: 'not booted' })
  let pty: Pty
  try {
    pty = await vm.spawn(undefined, undefined, { user: msg.user, cols: msg.cols, rows: msg.rows })
  } catch (e: any) {
    return send({ type: 'pty-ended', id: msg.id, exitCode: null, error: String(e?.message ?? e) })
  }
  ptys.set(msg.id, pty)
  send({ type: 'pty-opened', id: msg.id, pid: pty.pid })
  // Keep reading: the guest program blocks once the vsock window is full.
  const reader = pty.output.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const data = new Uint8Array(value)
      send({ type: 'pty-output', id: msg.id, data }, [data.buffer])
    }
  } catch {}
  const end = await pty.ended.catch(() => null)
  ptys.delete(msg.id)
  scheduleSync()
  send({ type: 'pty-ended', id: msg.id, exitCode: end?.type === 'exit' ? end.code : null })
}

port.on('message', (msg: HostMessage) => {
  switch (msg.type) {
    case 'boot':
      boot(msg.opts).then(
        () => send({ type: 'ready' }),
        (e) => send({ type: 'boot-error', message: String(e?.stack ?? e) })
      )
      return
    case 'exec':
      void exec(msg)
      return
    case 'abort':
      running.get(msg.id)?.abort('aborted')
      return
    case 'pty-open':
      void openPty(msg)
      return
    case 'pty-input':
      void ptys.get(msg.id)?.write(msg.data).catch(() => {})
      return
    case 'pty-resize':
      ptys.get(msg.id)?.resize(msg.cols, msg.rows)
      return
    case 'pty-close':
      void ptys.get(msg.id)?.close().catch(() => {})
      return
    case 'sync':
      void (vm?.sync() ?? Promise.resolve())
        .catch(() => {})
        .then(() => send({ type: 'synced', id: msg.id }))
      return
    case 'shutdown':
      void (async () => {
        clearTimeout(syncTimer)
        await vm?.sync().catch(() => {})
        process.exit(0)
      })()
  }
})
