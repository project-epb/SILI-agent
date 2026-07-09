import type { Logger } from '@koishijs/core'
import type {
  QuickJSContext,
  QuickJSRuntime,
  QuickJSHandle,
} from 'quickjs-emscripten'

// Note: by the time we get here, `value` has already been through
// vm.dump, which lossily flattens cycles to "[object Object]" and
// silently drops non-JSON members (functions, symbols, Map/Set
// contents). The try/catch + undefined check below catches the
// remaining cases that still reach the host: top-level Symbol
// returns (JSON.stringify → undefined) and any future caller that
// bypasses vm.dump. Self-referencing arrays crash inside vm.dump
// itself before reaching this function — see M3 review notes.
function serializeReturnValue(
  value: unknown,
  byteCap: number
): string | undefined {
  if (value === undefined) return undefined
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  const t = typeof value
  if (t === 'boolean' || t === 'number' || t === 'bigint') return String(value)

  let json: string | undefined
  try {
    json = JSON.stringify(value, null, 2)
  } catch {
    return `${String(value)} (note: value contains non-JSON parts)`
  }
  if (json === undefined) {
    return `${String(value)} (note: value contains non-JSON parts)`
  }

  const byteLen = Buffer.byteLength(json, 'utf8')
  if (byteLen <= byteCap) return json
  const sliced = Buffer.from(json, 'utf8').subarray(0, byteCap).toString('utf8')
  return `${sliced}\n... (truncated, ${(byteLen / 1024).toFixed(1)}KB total)`
}

function formatConsoleArg(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'string') return value as string
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(value)
  try {
    const json = JSON.stringify(value)
    if (json === undefined) return String(value)
    return json
  } catch {
    return String(value)
  }
}

function formatVmError(errInfo: unknown): string {
  if (errInfo && typeof errInfo === 'object') {
    const e = errInfo as { name?: string; message?: string }
    const head = `${e.name ?? 'Error'}: ${e.message ?? ''}`.trim()
    return head
  }
  return String(errInfo)
}

function isTimeoutError(deadline: number): boolean {
  return Date.now() > deadline
}

function isMemoryError(errInfo: unknown): boolean {
  const msg =
    errInfo && typeof errInfo === 'object'
      ? String((errInfo as { message?: string }).message ?? '')
      : String(errInfo)
  return /out of memory/i.test(msg)
}

/** Exported for direct unit tests; production callers go through run(). */
export function classifyError(
  errInfo: unknown,
  deadline: number,
  timeoutMessage: string,
  memoryMessage: string,
  abortReason: 'timeout' | 'rss' | null = null
): string {
  // Explicit abort from host-side interrupt handler wins over message-based
  // classification, because both timeout and RSS-watchdog aborts surface
  // through QuickJS as the same generic "InternalError: interrupted".
  if (abortReason === 'rss') return memoryMessage
  if (abortReason === 'timeout') return timeoutMessage
  if (isMemoryError(errInfo)) return memoryMessage
  if (isTimeoutError(deadline)) return timeoutMessage
  return formatVmError(errInfo)
}

export interface CodeSandboxRuntimeConfig {
  memoryLimitMb?: number
  defaultTimeoutMs?: number
  maxTimeoutMs?: number
  stdoutByteLimit?: number
  returnValueByteCap?: number
  /**
   * Escape hatch: skip setMemoryLimit + setMaxStackSize calls.
   * **Default false** — the limits are load-bearing DoS protection.
   *
   * Setting this true means sandboxed user code can allocate arbitrary
   * host memory (limited only by container cgroup), trivially weaponized
   * via prompt injection (`'A'.repeat(1e9)` → 1GB allocated, container
   * OOM'd). Only set true if you have an external isolation layer.
   *
   * History: there's a long-standing trap in the QuickJS WASM module
   * when setMemoryLimit is called from inside a long-running cordis
   * process (`RuntimeError: memory access out of bounds` on every call).
   * Fresh tsx processes work fine; per-call newQuickJSWASMModule didn't
   * sidestep it. The fix is process isolation via worker_threads, which
   * is what run() does. disableHostLimits remains an escape hatch for
   * legacy callers / debugging.
   */
  disableHostLimits?: boolean
  /**
   * Host-side RSS-growth cap (MB). Default 128. Best-effort defense
   * via interrupt-handler + async pump polling. NOT primary defense —
   * QuickJS interrupt handler is too rare and `await Promise.resolve()`
   * chains drain in one microtask flush. memoryLimitMb is the real
   * primary defense. RSS watchdog is kept for genuinely-long async
   * waits, no other.
   */
  rssGrowthCapMb?: number
  /**
   * Skip worker-thread isolation, run inline in the calling thread.
   * **Default false** — production uses workers because the QuickJS
   * WASM module traps inside the cordis main process. Set true only
   * for direct testing of the inner runSandboxInline logic.
   */
  inlineExecution?: boolean
}

export interface CodeSandboxResult {
  stdout: string
  /** main() 返回值，已序列化为字符串；undefined 表示无返回值段 */
  returnValue: string | undefined
  /** 非空表示执行失败（不论是 SyntaxError / 超时 / runtime 异常） */
  errorMessage: string | undefined
  durationMs: number
}

export interface RunOptions {
  timeoutMs?: number
}

export const DEFAULT_CONFIG: Required<CodeSandboxRuntimeConfig> = {
  memoryLimitMb: 32,
  defaultTimeoutMs: 3000,
  maxTimeoutMs: 10000,
  stdoutByteLimit: 10240,
  returnValueByteCap: 4096,
  disableHostLimits: false,
  rssGrowthCapMb: 128,
  inlineExecution: false,
}

// Loose logger type — only .warn is used. Keeps runSandboxInline portable
// across koishi/reggol/console contexts (worker doesn't need full koishi).
type LoggerLike = { warn(message: any, ...args: any[]): void }

/**
 * The actual QuickJS sandbox execution. Pure top-level function — runs
 * synchronously in the calling thread (no worker isolation). Used by:
 *
 *   1. The worker entry (`code-sandbox-worker.ts`) — production path,
 *      called inside a fresh V8 isolate so the cordis-main-process WASM
 *      trap can't reach us.
 *   2. `CodeSandboxRuntime.run()` with `inlineExecution: true` config —
 *      test path, exercises the QuickJS logic without worker machinery.
 *
 * Production callers MUST go through `CodeSandboxRuntime.run()` (worker
 * path) because in-process QuickJS execution is broken in SILI's
 * long-running cordis runtime — see disableHostLimits jsdoc for history.
 */
export async function runSandboxInline(
  code: string,
  cfg: Required<CodeSandboxRuntimeConfig>,
  opts: RunOptions = {},
  logger: LoggerLike
): Promise<CodeSandboxResult> {
  const startedAt = Date.now()
  // Hoisted so the outer catch can still return any partial stdout
  // captured before a host-side throw. .join('') reads by reference.
  const stdoutChunks: string[] = []
  let stdoutBytes = 0
  let stdoutTruncated = false
  const buildResult = (
    fields: Partial<CodeSandboxResult> = {}
  ): CodeSandboxResult => ({
    stdout: stdoutChunks.join(''),
    returnValue: undefined,
    errorMessage: undefined,
    durationMs: Date.now() - startedAt,
    ...fields,
  })

  // Mutable refs so the outer finally can dispose even if setup throws
  // partway through.
  let runtime: QuickJSRuntime | null = null
  let vm: QuickJSContext | null = null

  try {
    const { newQuickJSWASMModule, isFail } = await import('quickjs-emscripten')
    // Per-call fresh WASM module. Production additionally runs this entire
    // function inside a worker thread for V8-isolate isolation.
    const QuickJS = await newQuickJSWASMModule()
    runtime = QuickJS.newRuntime()
    if (!cfg.disableHostLimits) {
      runtime.setMemoryLimit(cfg.memoryLimitMb * 1024 * 1024)
      runtime.setMaxStackSize(256 * 1024)
    }
    vm = runtime.newContext()
    const timeoutMs = resolveTimeoutMs(opts, cfg)
    const deadline = startedAt + timeoutMs
    const timeoutMessage = `Error: execution timed out after ${timeoutMs}ms`
    const memoryMessage = 'Error: memory limit exceeded'

    const rssBaseline = process.memoryUsage().rss
    const rssCapBytes = cfg.rssGrowthCapMb * 1024 * 1024
    // QuickJS interrupt handler returns "stop" but doesn't tell us WHY
    // we stopped. Capture the reason here so classifyError can pick the
    // right message later (timeout vs memory).
    let abortReason: 'timeout' | 'rss' | null = null
    runtime.setInterruptHandler(() => {
      if (Date.now() > deadline) {
        abortReason = 'timeout'
        return true
      }
      if (process.memoryUsage().rss - rssBaseline > rssCapBytes) {
        abortReason = 'rss'
        return true
      }
      return false
    })

    const appendStdout = (line: string) => {
      if (stdoutTruncated) return
      const bytes = Buffer.byteLength(line, 'utf8')
      if (stdoutBytes + bytes > cfg.stdoutByteLimit) {
        stdoutTruncated = true
        stdoutChunks.push(`... (stdout truncated at ${stdoutBytes} bytes)\n`)
        return
      }
      stdoutChunks.push(line)
      stdoutBytes += bytes
    }

    // After this point vm/runtime are non-null; capture into locals to
    // keep TS narrowing happy through the rest of the function body.
    const vmCtx: QuickJSContext = vm
    const rt: QuickJSRuntime = runtime
    const makeLogFn = (prefix: 'log' | 'warn' | 'error') =>
      vmCtx.newFunction(prefix, (...handles: QuickJSHandle[]) => {
        const parts = handles.map((h) => formatConsoleArg(vmCtx.dump(h)))
        appendStdout(`[${prefix}] ${parts.join(' ')}\n`)
      })

    const logFn = makeLogFn('log')
    const warnFn = makeLogFn('warn')
    const errorFn = makeLogFn('error')
    const consoleObj = vm.newObject()
    vm.setProp(consoleObj, 'log', logFn)
    vm.setProp(consoleObj, 'warn', warnFn)
    vm.setProp(consoleObj, 'error', errorFn)
    vm.setProp(vm.global, 'console', consoleObj)
    logFn.dispose()
    warnFn.dispose()
    errorFn.dispose()
    consoleObj.dispose()

    const evalResult = vm.evalCode(code)
    if (isFail(evalResult)) {
      // Eval failures are always parse errors here — no memory/timeout classification needed.
      const errInfo = vm.dump(evalResult.error)
      evalResult.error.dispose()
      return buildResult({ errorMessage: formatVmError(errInfo) })
    }
    evalResult.value.dispose()

    const mainHandle = vm.getProp(vm.global, 'main')
    try {
      if (vm.typeof(mainHandle) !== 'function') {
        return buildResult({
          errorMessage:
            'Error: sandbox requires a top-level "function main()" entry (sync or async)',
        })
      }
      const callResult = vm.callFunction(mainHandle, vm.undefined)
      if (isFail(callResult)) {
        const errInfo = vm.dump(callResult.error)
        callResult.error.dispose()
        const errorMessage = classifyError(
          errInfo,
          deadline,
          timeoutMessage,
          memoryMessage,
          abortReason
        )
        return buildResult({ errorMessage })
      }
      const returnHandle = callResult.value
      // Thenable detection: peek at `.then` without invoking it. Promises
      // returned from sync function main() (manual `new Promise(...)`) and
      // from `async function main()` (auto-wrapped) both pass this check.
      let isThenable = false
      if (vm.typeof(returnHandle) === 'object') {
        const thenHandle = vm.getProp(returnHandle, 'then')
        isThenable = vm.typeof(thenHandle) === 'function'
        thenHandle.dispose()
      }
      if (!isThenable) {
        try {
          const nativeReturn = vm.dump(returnHandle)
          return buildResult({
            returnValue: serializeReturnValue(
              nativeReturn,
              cfg.returnValueByteCap
            ),
          })
        } finally {
          returnHandle.dispose()
        }
      }
      // Async path. vm.resolvePromise(handle) does NOT consume the input
      // handle (verified against quickjs-emscripten-core source: it calls
      // Promise.resolve(handle) via callFunction, which borrows args). So
      // we still own returnHandle and must dispose it in finally. The
      // settled result's .value / .error is a fresh handle (dup'd in the
      // resolve/reject callbacks) and must be disposed separately.
      const settledPromise = vm.resolvePromise(returnHandle)
      // Pump executePendingJobs while polling deadline. The host-side
      // settledPromise won't resolve unless VM jobs run; setInterruptHandler
      // alone doesn't trigger on never-resolving Promises. The 5ms sleep
      // keeps host CPU sane while preserving sub-50ms timeout precision.
      type Settled = Awaited<typeof settledPromise>
      let settled: Settled | null = null
      let abortedByPump: 'timeout' | 'rss' | null = null
      // Write settled via .then (not Promise.race) so we can interleave
      // executePendingJobs between host-side waits — race can't pump.
      settledPromise.then((v) => {
        settled = v
      })
      while (settled === null) {
        if (Date.now() > deadline) {
          abortedByPump = 'timeout'
          break
        }
        // Catch never-resolving Promises that grow host memory: the
        // VM-side interrupt handler can't fire because there's no VM
        // execution, so we need to check RSS here too.
        if (process.memoryUsage().rss - rssBaseline > rssCapBytes) {
          abortedByPump = 'rss'
          break
        }
        rt.executePendingJobs()
        await new Promise((r) => setTimeout(r, 5))
      }
      try {
        if (abortedByPump === 'timeout') {
          return buildResult({ errorMessage: timeoutMessage })
        }
        if (abortedByPump === 'rss') {
          return buildResult({ errorMessage: memoryMessage })
        }
        // settled is non-null past this point; widen for TS.
        const s = settled as Settled
        if (isFail(s)) {
          const errInfo = vm.dump(s.error)
          // Symmetric guard with the success branch below: vm.dump consumes
          // the handle when the value is itself a Promise (reachable via
          // `throw Promise.resolve(...)` in sandboxed code).
          if (s.error.alive) s.error.dispose()
          const errorMessage = classifyError(
            errInfo,
            deadline,
            timeoutMessage,
            memoryMessage,
            abortReason
          )
          return buildResult({ errorMessage })
        }
        const nativeReturn = vm.dump(s.value)
        // vm.dump consumes the handle when the value is itself a Promise; for
        // non-promise values it does not. Use .alive to avoid double-free.
        // (See chunk-V2S4ZYJR.mjs: getPromiseState branch in dump() disposes input.)
        if (s.value.alive) s.value.dispose()
        return buildResult({
          returnValue: serializeReturnValue(
            nativeReturn,
            cfg.returnValueByteCap
          ),
        })
      } finally {
        if (returnHandle.alive) returnHandle.dispose()
      }
    } finally {
      mainHandle.dispose()
    }
  } catch (e: any) {
    // Host-side throw: WASM trap (RuntimeError: memory access out of bounds /
    // unreachable / etc.), failure during runtime/context setup, or any
    // unexpected js-land error in dispose/dump/setProp. Without this catch
    // the error would escape, propagate through the tool handler, and
    // bubble up as a bare Error — burying useful context and exposing
    // internals to the LLM as if user code was at fault.
    const raw = e?.message ? String(e.message) : String(e)
    const isWasmTrap =
      /memory access out of bounds|RuntimeError|unreachable|null function|wasm/i.test(
        raw
      )
    const stack = e?.stack
      ? String(e.stack).split('\n').slice(0, 6).join('\n')
      : ''
    const heap = process.memoryUsage()
    logger.warn(
      '[code-sandbox] host trap in runSandboxInline: %s | heap rss=%dMB heapUsed=%dMB external=%dMB | stack:\n%s',
      raw,
      Math.round(heap.rss / 1024 / 1024),
      Math.round(heap.heapUsed / 1024 / 1024),
      Math.round((heap.external ?? 0) / 1024 / 1024),
      stack
    )
    const friendly = isWasmTrap
      ? `Error: sandbox host failure: ${raw}. WASM/host-side issue (not user code). If reproducible, bot logs have heap diagnostics; restart may help.`
      : `Error: sandbox host failure: ${raw}`
    return buildResult({ errorMessage: friendly })
  } finally {
    // Defensive disposal — both refs may be null if setup threw early,
    // and dispose itself can throw on a corrupted state (don't let that
    // escape and shadow the original error).
    try {
      vm?.dispose?.()
    } catch (e) {
      logger.warn('[code-sandbox] vm.dispose threw:', e)
    }
    try {
      runtime?.dispose?.()
    } catch (e) {
      logger.warn('[code-sandbox] runtime.dispose threw:', e)
    }
  }
}

/**
 * Run the sandbox in a worker_thread. Each call spawns a fresh worker,
 * runs runSandboxInline there, posts the result back, and terminates.
 * The worker gets its own V8 isolate — the cordis-main-process WASM
 * trap (singleton or otherwise) cannot reach the isolated isolate.
 *
 * Tradeoff: ~50-150ms worker startup per call. Acceptable for an
 * interactive tool; LLM round-trip dominates wall-clock anyway.
 */
/**
 * Resolve the effective per-call timeout, defending against NaN /
 * undefined / negative inputs that would otherwise propagate into
 * `setTimeout(fn, NaN)` (≡ 0 in Node) and kill the worker before it
 * could respond. Falls back through opts → cfg → DEFAULT_CONFIG.
 */
function resolveTimeoutMs(
  opts: RunOptions,
  cfg: Required<CodeSandboxRuntimeConfig>
): number {
  const sanitize = (v: unknown, fallback: number) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  const maxMs = sanitize(cfg.maxTimeoutMs, DEFAULT_CONFIG.maxTimeoutMs)
  const defaultMs = sanitize(
    cfg.defaultTimeoutMs,
    DEFAULT_CONFIG.defaultTimeoutMs
  )
  const requested = sanitize(opts.timeoutMs, defaultMs)
  return Math.min(Math.max(requested, 1), maxMs)
}

async function runViaWorker(
  code: string,
  opts: RunOptions,
  cfg: Required<CodeSandboxRuntimeConfig>,
  logger: LoggerLike
): Promise<CodeSandboxResult> {
  const { Worker } = await import('node:worker_threads')
  const startedAt = Date.now()
  const timeoutMs = resolveTimeoutMs(opts, cfg)

  return new Promise<CodeSandboxResult>((resolve) => {
    let settled = false
    const safeResolve = (r: CodeSandboxResult) => {
      if (settled) return
      settled = true
      resolve(r)
    }

    // Point Worker at the .cjs bootstrap instead of the .ts worker
    // entry directly. The bootstrap manually registers tsx (via
    // `tsx/cjs/api.register()`) because `--import tsx` is gated on
    // `isMainThread` and gets silently no-op'd in workers. After
    // bootstrap's register() runs, the chain require()-loads
    // code-sandbox-worker.ts and tsx handles nested imports.
    const workerUrl = new URL(
      './code-sandbox-worker-bootstrap.cjs',
      import.meta.url
    )
    let worker: import('node:worker_threads').Worker
    try {
      worker = new Worker(workerUrl, {
        workerData: { code, opts: { timeoutMs }, cfg },
        // Propagate parent flags (e.g. --no-opt from bun's wrapper);
        // no --import tsx needed, the bootstrap handles registration.
        execArgv: process.execArgv,
      })
    } catch (e: any) {
      // Worker construction itself failed (loader missing, file not
      // found, etc). Surface friendly error.
      logger.warn(
        '[code-sandbox] worker construction failed: %s',
        e?.message ?? String(e)
      )
      safeResolve({
        stdout: '',
        returnValue: undefined,
        errorMessage: `Error: sandbox worker construction failed: ${e?.message ?? String(e)}`,
        durationMs: Date.now() - startedAt,
      })
      return
    }

    // Hard wall-clock backstop: if worker doesn't reply within
    // timeoutMs + grace (covers WASM startup ~100ms + slack), kill it.
    const killTimer = setTimeout(() => {
      logger.warn(
        '[code-sandbox] worker did not respond within %dms + grace, terminating',
        timeoutMs
      )
      worker.terminate().catch(() => {})
      safeResolve({
        stdout: '',
        returnValue: undefined,
        errorMessage: `Error: execution timed out after ${timeoutMs}ms (worker terminated)`,
        durationMs: Date.now() - startedAt,
      })
    }, timeoutMs + 2000)

    worker.once(
      'message',
      (msg: { ok: boolean; result?: CodeSandboxResult; error?: string }) => {
        clearTimeout(killTimer)
        worker.terminate().catch(() => {})
        if (msg.ok && msg.result) {
          safeResolve(msg.result)
        } else {
          safeResolve({
            stdout: '',
            returnValue: undefined,
            errorMessage: `Error: sandbox worker failure: ${msg.error ?? 'no result returned'}`,
            durationMs: Date.now() - startedAt,
          })
        }
      }
    )

    worker.once('error', (e: Error) => {
      clearTimeout(killTimer)
      logger.warn(
        '[code-sandbox] worker error: %s\n%s',
        e.message,
        e.stack ?? ''
      )
      safeResolve({
        stdout: '',
        returnValue: undefined,
        errorMessage: `Error: sandbox worker crashed: ${e.message}`,
        durationMs: Date.now() - startedAt,
      })
    })

    worker.once('exit', (exitCode: number) => {
      clearTimeout(killTimer)
      // exit fires after message/error. If we already resolved, this is
      // a no-op via the safeResolve guard.
      if (exitCode !== 0) {
        safeResolve({
          stdout: '',
          returnValue: undefined,
          errorMessage: `Error: sandbox worker exited with code ${exitCode}`,
          durationMs: Date.now() - startedAt,
        })
      }
    })
  })
}

/**
 * Merge user config over defaults, dropping `undefined` values so that
 * explicitly-undefined keys don't shadow the default. Plugin glue like
 * `{ defaultTimeoutMs: sb.defaultTimeoutMs }` would otherwise pass
 * `undefined` whenever the user hadn't set the field, which a naive
 * spread would happily use to override the real default with undefined.
 * Bug history: NaN timeouts caused the worker kill-timer to fire as
 * `setTimeout(fn, 0)`, terminating the worker before it could respond.
 */
function mergeCfg(
  cfg: CodeSandboxRuntimeConfig
): Required<CodeSandboxRuntimeConfig> {
  const out = { ...DEFAULT_CONFIG }
  for (const key of Object.keys(cfg) as (keyof CodeSandboxRuntimeConfig)[]) {
    const v = cfg[key]
    if (v !== undefined) (out as any)[key] = v
  }
  return out
}

export class CodeSandboxRuntime {
  private cfg: Required<CodeSandboxRuntimeConfig>

  constructor(
    private logger: Logger,
    cfg: CodeSandboxRuntimeConfig = {}
  ) {
    this.cfg = mergeCfg(cfg)
  }

  /**
   * Production entry: runs the sandbox in a worker thread for V8-isolate
   * isolation (the in-process WASM path is broken in cordis long-running
   * processes — see disableHostLimits jsdoc). Tests can opt into the
   * inline path via `inlineExecution: true` config.
   */
  async run(code: string, opts: RunOptions = {}): Promise<CodeSandboxResult> {
    if (this.cfg.inlineExecution) {
      return runSandboxInline(code, this.cfg, opts, this.logger)
    }
    return runViaWorker(code, opts, this.cfg, this.logger)
  }

  /**
   * Pre-load and pre-compile the QuickJS WASM bytecode so the first
   * user-facing tool call doesn't pay the ~100-200ms compile cost.
   * Each `run()` still instantiates a fresh module in a fresh worker,
   * but V8 caches `WebAssembly.compile` results by source bytes, so
   * subsequent instantiations are faster (~20-50ms).
   *
   * Idempotent. Safe to call multiple times.
   */
  async warmup(): Promise<void> {
    const { newQuickJSWASMModule } = await import('quickjs-emscripten')
    const QuickJS = await newQuickJSWASMModule()
    const rt = QuickJS.newRuntime()
    try {
      const vm = rt.newContext()
      vm.dispose()
    } finally {
      rt.dispose()
    }
  }
}
