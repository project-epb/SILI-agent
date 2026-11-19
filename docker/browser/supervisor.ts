/**
 * The only way into the shared browser.
 *
 * Chrome's DevTools port has no auth and rejects non-IP Host headers, so it
 * listens on 127.0.0.1 only and this process fronts it:
 *   GET /health         200 while Chrome is up
 *   WS  /?token=<token> proxied to Chrome's browser endpoint
 *
 * It also keeps the long-running Chrome healthy, since nothing restarts it
 * along with sili-core anymore:
 *   - pages older than PAGE_MAX_AGE_MS are closed, and browser contexts left
 *     without pages are disposed (callers do leak pages);
 *   - Chrome is restarted when idle and old or big (Chromium memory only grows);
 *   - Chrome is restarted when it exits. Every restart drops all clients, which
 *     reconnect on their own.
 *
 * Runs on bun with no dependencies.
 */
import { type Subprocess, spawn } from 'bun'

import { readFileSync, rmSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'

const env = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback
  if (value === undefined) throw new Error(`${name} is not set`)
  return value
}

const TOKEN = env('BROWSER_TOKEN')
const CHROME = env('CHROME_PATH', '/opt/chrome/chrome-headless-shell')
const PORT = Number(env('PORT', '3000'))
const DEVTOOLS_PORT = 9222
const PAGE_MAX_AGE_MS = Number(env('PAGE_MAX_AGE_MS', '120000'))
const EMPTY_CONTEXT_MAX_AGE_MS = 30_000
const RECYCLE_AFTER_MS = Number(env('RECYCLE_AFTER_MS', String(6 * 3600_000)))
const RECYCLE_ABOVE_BYTES = Number(
  env('RECYCLE_ABOVE_BYTES', String(600 * 1024 * 1024))
)
const SWEEP_INTERVAL_MS = 10_000
const PROFILE_DIR = '/tmp/chrome-profile'

const log = (...args: unknown[]) =>
  console.log(new Date().toISOString(), '[browser]', ...args)

// ── Chrome process ──────────────────────────────────────────────────────────

let chrome: Subprocess | undefined
let chromeStartedAt = 0
let browserWsUrl: string | undefined
let stopping = false

async function startChrome() {
  rmSync(PROFILE_DIR, { recursive: true, force: true })
  chrome = spawn(
    [
      CHROME,
      `--remote-debugging-port=${DEVTOOLS_PORT}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${PROFILE_DIR}`,
      // Docker gives /dev/shm 64 MB; Chrome crashes on big pages without this.
      '--disable-dev-shm-usage',
      // The container is the sandbox; Chrome's own needs privileges docker withholds.
      '--no-sandbox',
      '--no-first-run',
      '--mute-audio',
      '--hide-scrollbars',
    ],
    { stdout: 'inherit', stderr: 'inherit' }
  )
  chromeStartedAt = Date.now()
  const proc = chrome
  proc.exited.then((code) => {
    if (chrome !== proc) return
    log(`chrome exited (${code})`)
    onChromeGone()
    if (!stopping) setTimeout(startChrome, 1000)
  })

  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/version`)
      const { webSocketDebuggerUrl } = (await res.json()) as {
        webSocketDebuggerUrl: string
      }
      if (chrome !== proc) return
      browserWsUrl = webSocketDebuggerUrl
      log('chrome ready')
      watch(webSocketDebuggerUrl)
      return
    } catch {
      await Bun.sleep(100)
    }
  }
  log('chrome did not come up, killing it')
  proc.kill('SIGKILL')
}

function onChromeGone() {
  browserWsUrl = undefined
  watcher?.close()
  watcher = undefined
  pages.clear()
  contexts.clear()
  for (const client of clients) client.close(1012, 'browser restarting')
}

async function restartChrome(reason: string) {
  log('restarting chrome:', reason)
  const proc = chrome
  if (!proc) return
  proc.kill('SIGTERM')
  const timer = setTimeout(() => proc.kill('SIGKILL'), 5000)
  await proc.exited
  clearTimeout(timer)
  // The exit handler schedules the next start.
}

// ── watchdog over CDP ───────────────────────────────────────────────────────

let watcher: WebSocket | undefined
/** page targetId → { created, browserContextId } */
const pages = new Map<string, { created: number; contextId?: string }>()
/** non-default browserContextId → first seen */
const contexts = new Map<string, number>()
let nextId = 1
const pending = new Map<number, (result: any) => void>()

function send(method: string, params: object = {}): Promise<any> {
  const ws = watcher
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve(null)
  const id = nextId++
  return new Promise((resolve) => {
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

function watch(url: string) {
  const ws = new WebSocket(url)
  watcher = ws
  ws.onopen = () => send('Target.setDiscoverTargets', { discover: true })
  // A request in flight when Chrome goes away never gets a reply; settle it so
  // sweep() does not hang.
  ws.onclose = () => {
    for (const resolve of pending.values()) resolve(null)
    pending.clear()
  }
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(String(data))
    if (msg.id) {
      pending.get(msg.id)?.(msg.result ?? null)
      pending.delete(msg.id)
      return
    }
    const info = msg.params?.targetInfo
    if (msg.method === 'Target.targetCreated' && info?.type === 'page') {
      pages.set(info.targetId, {
        created: Date.now(),
        contextId: info.browserContextId,
      })
    } else if (msg.method === 'Target.targetDestroyed') {
      pages.delete(msg.params.targetId)
    }
  }
}

async function sweep() {
  if (!browserWsUrl) return
  const now = Date.now()

  for (const [targetId, page] of pages) {
    if (now - page.created > PAGE_MAX_AGE_MS) {
      log('closing page past max age:', targetId)
      pages.delete(targetId)
      await send('Target.closeTarget', { targetId })
    }
  }

  const result = await send('Target.getBrowserContexts')
  const live = new Set<string>(result?.browserContextIds ?? [])
  for (const id of contexts.keys()) if (!live.has(id)) contexts.delete(id)
  const used = new Set([...pages.values()].map((p) => p.contextId))
  for (const id of live) {
    if (!contexts.has(id)) contexts.set(id, now)
    if (!used.has(id) && now - contexts.get(id)! > EMPTY_CONTEXT_MAX_AGE_MS) {
      log('disposing empty context:', id)
      contexts.delete(id)
      await send('Target.disposeBrowserContext', { browserContextId: id })
    }
  }

  if (pages.size === 0) {
    const uptime = now - chromeStartedAt
    const memory = containerMemory()
    if (uptime > RECYCLE_AFTER_MS) {
      await restartChrome(`idle, up ${Math.round(uptime / 60_000)} min`)
    } else if (memory > RECYCLE_ABOVE_BYTES) {
      await restartChrome(`idle, ${Math.round(memory / 1048576)} MB in use`)
    }
  }
}

/** Anonymous memory of the container (cgroup v2), i.e. what OOM counts minus page cache. */
function containerMemory(): number {
  try {
    const stat = readFileSync('/sys/fs/cgroup/memory.stat', 'utf8')
    return Number(/^anon (\d+)$/m.exec(stat)?.[1] ?? 0)
  } catch {
    return 0
  }
}

// ── client proxy ────────────────────────────────────────────────────────────

type ClientData = { upstream?: WebSocket; queue: (string | Buffer)[] }
const clients = new Set<import('bun').ServerWebSocket<ClientData>>()

function tokenMatches(given: string | null) {
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
}

Bun.serve<ClientData, never>({
  port: PORT,
  hostname: '0.0.0.0',
  fetch(req, server) {
    const url = new URL(req.url)
    if (url.pathname === '/health') {
      return new Response(browserWsUrl ? 'ok' : 'starting', {
        status: browserWsUrl ? 200 : 503,
      })
    }
    if (!tokenMatches(url.searchParams.get('token'))) {
      return new Response('unauthorized', { status: 401 })
    }
    if (!browserWsUrl) return new Response('starting', { status: 503 })
    if (server.upgrade(req, { data: { queue: [] } })) return
    return new Response('expected a websocket', { status: 400 })
  },
  websocket: {
    // Screenshots arrive as one base64 CDP message; full-page ones are big.
    maxPayloadLength: 256 * 1024 * 1024,
    // CDP connections sit idle between jobs; don't drop them.
    idleTimeout: 0,
    open(client) {
      clients.add(client)
      const upstream = new WebSocket(browserWsUrl!)
      client.data.upstream = upstream
      upstream.binaryType = 'nodebuffer'
      upstream.onopen = () => {
        for (const msg of client.data.queue) upstream.send(msg)
        client.data.queue = []
      }
      upstream.onmessage = ({ data }) => client.send(data as string | Buffer)
      upstream.onclose = () => client.close(1011, 'browser closed')
      upstream.onerror = () => client.close(1011, 'browser error')
    },
    message(client, msg) {
      const upstream = client.data.upstream
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(msg)
      else client.data.queue.push(msg)
    },
    close(client) {
      clients.delete(client)
      client.data.upstream?.close()
    },
  },
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    stopping = true
    chrome?.kill('SIGTERM')
    await chrome?.exited
    process.exit(0)
  })
}

let sweeping = false
setInterval(() => {
  if (sweeping) return
  sweeping = true
  sweep()
    .catch((e) => log('sweep failed:', e))
    .finally(() => (sweeping = false))
}, SWEEP_INTERVAL_MS)

log(`listening on :${PORT}`)
await startChrome()
