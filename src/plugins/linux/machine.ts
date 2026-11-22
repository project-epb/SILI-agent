import type { Logger } from 'koishi'

import { Worker } from 'node:worker_threads'

import type { BootOptions, HostMessage, WorkerMessage } from './protocol'

export const WORKSPACE = '/workspace'
const JOBS_DIR = `${WORKSPACE}/.jobs`
const PROVISIONED_MARK = '/var/lib/sili/provisioned'
const PACKAGES = ['bash', 'python3', 'py3-pip', 'curl', 'jq', 'git', 'ripgrep', 'file']
const PROVISION_TIMEOUT_MS = 10 * 60_000
/**
 * unkernel's kw layer ships these as shims that download the real program
 * into ~/.local/bin on first call (node alone is ~200 MB): a first `node -v`
 * in a tool call blows the 30 s default timeout. Fetch them while booting.
 */
const KW_RUNTIMES = ['node', 'bun', 'uv']

export interface RunOptions {
  input?: Uint8Array | string
  /** Default `user` (uid 1000, passwordless sudo). */
  user?: string
  timeoutMs?: number
  signal?: AbortSignal
  maxBuffer?: number
}

export interface RunResult {
  stdout: Uint8Array
  stderr: Uint8Array
  exitCode: number | null
  signal: number | null
  /** Ended by timeoutMs. */
  timedOut: boolean
  /** Ended by RunOptions.signal. */
  aborted: boolean
}

export interface ShellResult extends RunResult {
  /** Where the command ended, when it got that far. */
  finalCwd?: string
}

export interface Job {
  id: string
  pid: number
  logPath: string
  /** Resolves when the job ends, or with exitCode null if the machine went down. */
  done: Promise<{ exitCode: number | null; logTail: string; durationMs: number }>
}

/** Thrown when the VM is down or went down mid-call; the next call reboots it. */
export class MachineDownError extends Error {}

/**
 * The one Linux VM, run in a worker thread (see worker.ts). Boots on first
 * use; a VM that exits (panic, wasm trap, OOM) fails the calls in flight
 * and boots again on the next one.
 */
export class LinuxMachine {
  #worker?: Worker
  #booting?: Promise<void>
  #nextId = 1
  #cwdSeq = 1
  #pending = new Map<number, (msg: WorkerMessage) => void>()
  #bootedAt?: Date

  constructor(
    private readonly opts: BootOptions,
    private readonly logger: Logger
  ) {}

  get bootedAt() {
    return this.#bootedAt
  }

  ensure(): Promise<void> {
    if (!this.#booting) {
      const booting = this.#boot().catch((e) => {
        if (this.#booting === booting) this.#teardown(e)
        throw e
      })
      this.#booting = booting
    }
    return this.#booting
  }

  async #boot() {
    const started = Date.now()
    const worker = new Worker(new URL('./worker.ts', import.meta.url))
    this.#worker = worker
    // Events of a worker already torn down (a restart) must not touch its
    // successor: its late `exit` would tear the new one down.
    const down = (error: Error) => {
      if (this.#worker === worker) this.#teardown(error)
    }
    await new Promise<void>((resolve, reject) => {
      worker.on('message', (msg: WorkerMessage) => {
        if (msg.type === 'ready') return resolve()
        if (msg.type === 'boot-error') return reject(new MachineDownError(msg.message))
        if (msg.type === 'exited') {
          this.logger.warn('[linux] machine exited: %s', msg.reason)
          return down(new MachineDownError(`the machine went down (${msg.reason})`))
        }
        if (msg.type === 'result' || msg.type === 'error' || msg.type === 'synced')
          this.#pending.get(msg.id)?.(msg)
      })
      worker.on('error', (e) => {
        this.logger.warn('[linux] worker error:', e)
        reject(e)
        down(new MachineDownError(`the machine crashed: ${e.message}`))
      })
      worker.on('exit', () => {
        reject(new MachineDownError('the machine stopped while booting'))
        down(new MachineDownError('the machine stopped'))
      })
      this.#post({ type: 'boot', opts: this.opts })
    })
    this.#bootedAt = new Date()
    this.logger.info('[linux] booted in %dms', Date.now() - started)
    await this.#provision()
  }

  async #provision() {
    const script = [
      `mkdir -p ${JOBS_DIR} && chown user:user ${WORKSPACE} ${JOBS_DIR}`,
      `[ -f ${PROVISIONED_MARK} ] && exit 0`,
      // apk starts with only main; ripgrep and friends live in community.
      "grep -q '/community$' /etc/apk/repositories || sed -n 's|/main$|/community|p' /etc/apk/repositories >> /etc/apk/repositories",
      `apk add -q ${PACKAGES.join(' ')}`,
      `mkdir -p $(dirname ${PROVISIONED_MARK}) && touch ${PROVISIONED_MARK}`,
    ].join('\n')
    const r = await this.run(['sh', '-ec', script], {
      user: 'root',
      timeoutMs: PROVISION_TIMEOUT_MS,
    })
    if (r.exitCode !== 0)
      this.logger.warn('[linux] provisioning failed: %s', decode(r.stderr).slice(-2000))
    const fetch = KW_RUNTIMES.map(
      (t) => `[ -e "$HOME/.local/bin/${t}" ] || /usr/lib/kw/bin/${t} --version >/dev/null`
    ).join('\n')
    const f = await this.run(['sh', '-ec', fetch], { user: 'user', timeoutMs: PROVISION_TIMEOUT_MS })
    if (f.exitCode !== 0)
      this.logger.warn('[linux] fetching runtimes failed: %s', decode(f.stderr).slice(-2000))
  }

  #post(msg: HostMessage, transfer: ArrayBuffer[] = []) {
    this.#worker?.postMessage(msg, transfer)
  }

  #teardown(error: Error) {
    const worker = this.#worker
    if (!worker && !this.#booting) return
    this.#worker = undefined
    this.#booting = undefined
    this.#bootedAt = undefined
    for (const settle of this.#pending.values())
      settle({ type: 'error', id: 0, code: 'DOWN', message: error.message })
    this.#pending.clear()
    void worker?.terminate()
  }

  /** Run argv in the guest. Never rejects for the program's own failure. */
  async run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
    if (!this.#bootedAt) await this.ensure()
    const id = this.#nextId++
    const input =
      typeof opts.input === 'string' ? new TextEncoder().encode(opts.input) : opts.input
    const reply = new Promise<WorkerMessage>((resolve) => this.#pending.set(id, resolve))
    const onAbort = () => this.#post({ type: 'abort', id })
    if (opts.signal?.aborted) onAbort()
    else opts.signal?.addEventListener('abort', onAbort, { once: true })
    this.#post({
      type: 'exec',
      id,
      argv,
      input,
      user: opts.user ?? 'user',
      timeoutMs: opts.timeoutMs,
      maxBuffer: opts.maxBuffer,
    })
    const msg = await reply.finally(() => {
      this.#pending.delete(id)
      opts.signal?.removeEventListener('abort', onAbort)
    })
    if (msg.type === 'result')
      return { ...msg, timedOut: false, aborted: false }
    if (msg.type === 'error' && (msg.code === 'TIMEOUT' || msg.code === 'ABORTED'))
      return {
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        exitCode: null,
        signal: null,
        timedOut: msg.code === 'TIMEOUT',
        aborted: msg.code === 'ABORTED',
      }
    if (msg.type === 'error' && msg.code === 'DOWN') throw new MachineDownError(msg.message)
    throw new Error(msg.type === 'error' ? `${msg.code}: ${msg.message}` : 'unexpected reply')
  }

  /**
   * A shell command run from `cwd`. A `cd` inside lasts only for this call;
   * where it ended is reported back.
   */
  async shell(command: string, cwd: string, opts: RunOptions = {}): Promise<ShellResult> {
    const cwdFile = `/tmp/.sili-cwd-${this.#cwdSeq++}`
    const wrapper = 'cd "$1" || exit 1; eval "$2"; s=$?; pwd > "$3" 2>/dev/null; exit $s'
    const r = await this.run(['sh', '-c', wrapper, 'sh', cwd, command, cwdFile], opts)
    const end = await this.run(['sh', '-c', 'cat "$1" 2>/dev/null; rm -f "$1"', 'sh', cwdFile], {
      user: opts.user,
    })
    const finalCwd = decode(end.stdout).trim() || undefined
    return { ...r, finalCwd }
  }

  async mkdir(dir: string) {
    await this.run(['mkdir', '-p', '--', dir])
  }

  /** The file's bytes, or an error message when it cannot be read whole. */
  async readFile(file: string, maxBytes: number): Promise<Uint8Array | string> {
    const stat = await this.run(['stat', '-L', '-c', '%F %s', '--', file])
    if (stat.exitCode !== 0) return decode(stat.stderr).trim() || `cannot stat ${file}`
    const [kind, size] = decode(stat.stdout).trim().split(/ (?=\d+$)/)
    if (kind !== 'regular file' && kind !== 'regular empty file') return `${file} is a ${kind}, not a regular file`
    if (Number(size) > maxBytes) return `${file} is ${size} bytes, over the ${maxBytes}-byte limit`
    const r = await this.run(['cat', '--', file], { maxBuffer: maxBytes + 1 })
    if (r.exitCode !== 0) return decode(r.stderr).trim() || `cannot read ${file}`
    return r.stdout
  }

  /** Write bytes to a file, creating its directory. Returns an error message or ''. */
  async writeFile(file: string, bytes: Uint8Array | string): Promise<string> {
    const r = await this.run(
      ['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', file],
      { input: bytes }
    )
    return r.exitCode === 0 ? '' : decode(r.stderr).trim() || `cannot write ${file}`
  }

  /** Start a command that outlives the call; `done` settles when it ends. */
  async startJob(command: string, cwd: string): Promise<Job> {
    const id = `job-${Date.now().toString(36)}`
    const dir = `${JOBS_DIR}/${id}`
    const logPath = `${dir}/log`
    const start = [
      'mkdir -p "$3" && cd "$1" || exit 1',
      // A subshell, so an `exit` in the command still gets its status recorded.
      `setsid sh -c '(eval "$1"); echo $? > "$2/exit"' sh "$2" "$3" > "$3/log" 2>&1 < /dev/null &`,
      'echo $!',
    ].join('\n')
    const r = await this.run(['sh', '-c', start, 'sh', cwd, command, dir], { timeoutMs: 30_000 })
    const pid = Number(decode(r.stdout).trim())
    if (r.exitCode !== 0 || !pid) throw new Error(decode(r.stderr).trim() || 'the job did not start')
    const started = Date.now()
    const wait = 'while kill -0 "$1" 2>/dev/null; do sleep 1; done; cat "$2/exit" 2>/dev/null'
    const done = this.run(['sh', '-c', wait, 'sh', String(pid), dir])
      .then(async (w) => {
        const code = decode(w.stdout).trim()
        const tail = await this.run(['tail', '-c', '2000', logPath])
        return {
          exitCode: code === '' ? null : Number(code),
          logTail: decode(tail.stdout),
          durationMs: Date.now() - started,
        }
      })
      .catch((e) => ({
        exitCode: null,
        logTail: `(${e instanceof Error ? e.message : e})`,
        durationMs: Date.now() - started,
      }))
    return { id, pid, logPath, done }
  }

  /**
   * Flush the guest's writes into the data disk file. What is on the file
   * then matches a machine that lost power at that moment. No-op when off.
   */
  async sync(): Promise<void> {
    if (!this.#bootedAt) return
    const id = this.#nextId++
    const reply = new Promise<WorkerMessage>((resolve) => this.#pending.set(id, resolve))
    this.#post({ type: 'sync', id })
    const msg = await reply.finally(() => this.#pending.delete(id))
    if (msg.type === 'error') throw new MachineDownError(msg.message)
  }

  async restart() {
    if (this.#bootedAt)
      await this.run(['sync'], { user: 'root', timeoutMs: 10_000 }).catch(() => {})
    this.#teardown(new MachineDownError('the machine was restarted'))
    await this.ensure()
  }

  dispose() {
    this.#post({ type: 'shutdown' })
    setTimeout(() => this.#teardown(new MachineDownError('the machine was shut down')), 5000).unref?.()
  }
}

export function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}
