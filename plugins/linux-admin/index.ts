import { Context } from 'koishi'

import { resolve } from 'node:path'

import '@koishijs/console'

import type LinuxService from '../../src/plugins/linux'
import { JOBS_DIR, type PtyHandle, decode } from '../../src/plugins/linux/machine'

/**
 * Console page for SILI's Linux machine (spec: 2026-11-22-linux-admin-webui-
 * design.md). Every listener needs authority 4. Files move through commands
 * in the guest, never a host mount (linux-agent spec, decision 5).
 */
const AUTH = { authority: 4 }
const MAX_FILE_BYTES = 50 * 1024 * 1024
const EDIT_BYTES = 1024 * 1024

export const name = 'linux-admin'
export const inject = ['console', 'linux']

type User = 'user' | 'root'
const asUser = (root?: boolean): User => (root ? 'root' : 'user')

interface Entry {
  name: string
  type: 'dir' | 'file' | 'link' | 'other'
  size: number
  mtime: number
}

/** The console client a listener runs for (`this` in addListener). */
interface ConsoleClient {
  id: string
  send(payload: { type: string; body: unknown }): void
  socket: { addEventListener(type: 'close', cb: () => void): void }
}

/** Push channel for terminal output; see client/index.js. */
const TERM_EVENT = 'linux-admin/term'

export function apply(ctx: Context) {
  const linux = () => (ctx as any).linux as LinuxService
  const machine = () => linux().machine

  ctx.console.addListener(
    'linux-admin/status',
    async () => {
      const m = machine()
      const backup = linux().lastBackup
      if (!m.bootedAt) return { running: false, backup }
      const r = await m.run(['sh', '-c', 'df -h / | tail -1; echo ---; free -m | sed -n 2p'], { timeoutMs: 10_000 })
      const [df, mem] = decode(r.stdout).split('---\n')
      // free -m: total used free shared buff/cache available
      const [total, used, , , , available] = (mem ?? '').trim().split(/\s+/).slice(1).map(Number)
      return {
        running: true,
        bootedAt: m.bootedAt.getTime(),
        backup,
        df: df.trim(),
        mem: total ? `共 ${total} MiB，已用 ${used} MiB，可用 ${available} MiB` : '',
        jobs: await listJobs(),
      }
    },
    AUTH
  )

  ctx.console.addListener('linux-admin/restart', async () => void (await machine().restart()), AUTH)
  ctx.console.addListener('linux-admin/backup', async () => linux().backup(), AUTH)

  async function listJobs() {
    // One line per job: id, pid, start time, running?, exit code, command.
    const script = [
      `cd ${JOBS_DIR} 2>/dev/null || exit 0`,
      'for d in job-*; do [ -d "$d" ] || continue',
      '  pid=$(cat "$d/pid" 2>/dev/null); code=$(cat "$d/exit" 2>/dev/null)',
      '  alive=0; [ -z "$code" ] && [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && alive=1',
      '  printf "%s\\t%s\\t%s\\t%s\\t%s\\t" "$d" "$pid" "$(stat -c %Y "$d")" "$alive" "$code"',
      '  head -c 300 "$d/cmd" 2>/dev/null | tr "\\n\\t" "  "; echo',
      'done',
    ].join('\n')
    const r = await machine().run(['sh', '-c', script], { timeoutMs: 10_000 })
    return decode(r.stdout)
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id, pid, started, alive, exit, command] = line.split('\t')
        return {
          id,
          pid: Number(pid) || null,
          startedAt: Number(started) * 1000,
          running: alive === '1',
          exitCode: exit === '' || exit === undefined ? null : Number(exit),
          command: command ?? '',
        }
      })
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  ctx.console.addListener(
    'linux-admin/job-kill',
    async ({ pid }: { pid: number }) => {
      if (!Number.isInteger(pid) || pid <= 1) throw new Error('bad pid')
      // The job runs under setsid: its pid leads the process group. busybox
      // kill takes no `--`; a negative pid right after the signal is a group.
      const r = await machine().run(['sh', '-c', 'kill -TERM "-$1" 2>&1 || kill -TERM "$1" 2>&1', 'sh', String(pid)], {
        user: 'root',
        timeoutMs: 10_000,
      })
      if (r.exitCode !== 0) throw new Error(decode(r.stdout).trim() || 'kill failed')
    },
    AUTH
  )

  // ---- terminal -------------------------------------------------------------

  const terms = new Map<string, { client: string; pty: PtyHandle }>()
  const watched = new WeakSet<object>()
  let nextTerm = 1

  ctx.console.addListener(
    'linux-admin/term-open',
    async function (this: ConsoleClient, { root, cols, rows }: { root?: boolean; cols: number; rows: number }) {
      const client = this
      const termId = `t${nextTerm++}`
      const push = (body: Record<string, unknown>) => {
        try {
          client.send({ type: TERM_EVENT, body: { termId, ...body } })
        } catch {}
      }
      const pty = await machine().openPty(
        { user: asUser(root), cols: clamp(cols, 20, 500), rows: clamp(rows, 5, 200) },
        {
          output: (data) => push({ data: Buffer.from(data).toString('base64') }),
          end: (exitCode, error) => {
            terms.delete(termId)
            push({ ended: true, exitCode, error })
          },
        }
      )
      terms.set(termId, { client: client.id, pty })
      // A closed or reloaded page hangs up its shells (spec decision 3).
      if (!watched.has(client)) {
        watched.add(client)
        client.socket.addEventListener('close', () => {
          for (const [id, t] of terms) if (t.client === client.id) (t.pty.close(), terms.delete(id))
        })
      }
      return { termId, pid: pty.pid }
    },
    AUTH
  )

  /** Only the page that opened a terminal may drive it. */
  const ownTerm = (client: ConsoleClient, termId: string) => {
    const t = terms.get(termId)
    if (!t || t.client !== client.id) throw new Error('no such terminal')
    return t.pty
  }
  ctx.console.addListener(
    'linux-admin/term-input',
    async function (this: ConsoleClient, { termId, data }: { termId: string; data: string }) {
      ownTerm(this, termId).write(data)
    },
    AUTH
  )
  ctx.console.addListener(
    'linux-admin/term-resize',
    async function (this: ConsoleClient, { termId, cols, rows }: { termId: string; cols: number; rows: number }) {
      ownTerm(this, termId).resize(clamp(cols, 20, 500), clamp(rows, 5, 200))
    },
    AUTH
  )
  ctx.console.addListener(
    'linux-admin/term-close',
    async function (this: ConsoleClient, { termId }: { termId: string }) {
      ownTerm(this, termId).close()
    },
    AUTH
  )

  // ---- files ----------------------------------------------------------------

  ctx.console.addListener(
    'linux-admin/fs-list',
    async ({ path, root }: { path: string; root?: boolean }): Promise<{ path: string; entries: Entry[] }> => {
      // %F is the type, %s size, %Y mtime; names come last so tabs in them survive the split.
      const script = [
        'cd -- "$1" || exit 1; pwd',
        'for f in .* *; do [ "$f" = . ] || [ "$f" = .. ] && continue; [ -e "$f" ] || [ -L "$f" ] || continue',
        '  stat -c "%F\t%s\t%Y\t%n" -- "$f"',
        'done',
      ].join('\n')
      const r = await machine().run(['sh', '-c', script, 'sh', path || '/home/user'], { user: asUser(root), timeoutMs: 15_000 })
      if (r.exitCode !== 0) throw new Error(decode(r.stderr).trim() || `cannot list ${path}`)
      const [cwd, ...lines] = decode(r.stdout).split('\n').filter(Boolean)
      const entries = lines.map((line): Entry => {
        const [kind, size, mtime, ...name] = line.split('\t')
        return {
          name: name.join('\t'),
          type: kind === 'directory' ? 'dir' : kind === 'symbolic link' ? 'link' : kind.includes('regular') ? 'file' : 'other',
          size: Number(size),
          mtime: Number(mtime) * 1000,
        }
      })
      entries.sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || (a.name < b.name ? -1 : 1))
      return { path: cwd, entries }
    },
    AUTH
  )

  ctx.console.addListener(
    'linux-admin/fs-read',
    async ({ path, root, text }: { path: string; root?: boolean; text?: boolean }) => {
      const bytes = await machine().readFile(path, text ? EDIT_BYTES : MAX_FILE_BYTES, asUser(root))
      if (typeof bytes === 'string') throw new Error(bytes)
      if (text) {
        const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes) // throws on binary
        return { text: content }
      }
      return { base64: Buffer.from(bytes).toString('base64') }
    },
    AUTH
  )

  ctx.console.addListener(
    'linux-admin/fs-write',
    async ({ path, root, text, base64 }: { path: string; root?: boolean; text?: string; base64?: string }) => {
      const bytes = text !== undefined ? new TextEncoder().encode(text) : Buffer.from(base64 ?? '', 'base64')
      if (bytes.length > MAX_FILE_BYTES) throw new Error(`over ${MAX_FILE_BYTES / 1024 / 1024} MiB`)
      const error = await machine().writeFile(path, bytes, asUser(root))
      if (error) throw new Error(error)
    },
    AUTH
  )

  const fsCommand = async (argv: string[], root?: boolean) => {
    const r = await machine().run(argv, { user: asUser(root), timeoutMs: 60_000 })
    if (r.exitCode !== 0) throw new Error(decode(r.stderr).trim() || `${argv[0]} failed`)
  }
  ctx.console.addListener(
    'linux-admin/fs-mkdir',
    async ({ path, root }: { path: string; root?: boolean }) => fsCommand(['mkdir', '-p', '--', path], root),
    AUTH
  )
  ctx.console.addListener(
    'linux-admin/fs-delete',
    async ({ path, root }: { path: string; root?: boolean }) => {
      if (!path || path === '/' || !path.startsWith('/')) throw new Error('refusing to delete that')
      return fsCommand(['rm', '-rf', '--', path], root)
    },
    AUTH
  )

  const clientDir = resolve(ctx.baseDir, 'node_modules/koishi-plugin-linux-admin/client')
  ctx.console.addEntry({ dev: clientDir, prod: clientDir })
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, Math.round(Number(n) || lo)))
}
