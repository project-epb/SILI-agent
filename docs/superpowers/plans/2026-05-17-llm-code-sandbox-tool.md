# LLM Code Sandbox Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 SILI 的 LLM agent 增加 `run_code_sandbox` 工具：在 QuickJS（WASM）沙箱里执行用户提供的 JS code，入口契约 `function main()`（sync/async 均可），不联网/不读盘/不预置第三方库。

**Architecture:** 单文件 runtime（`services/code-sandbox-runtime.ts`）封装 QuickJS 生命周期、host 注入、超时与序列化；薄工具包装（`tools/code-sandbox.ts`）只做参数 clamp、调用 runtime、拼接 markdown 输出；按现有 `ToolRegistry` 模式注册到 LLM 插件。

**Tech Stack:** `quickjs-emscripten`（WASM，无 native addon）、vitest、koishi/cordis 插件框架、TypeScript、bun。

**参考 spec：** `docs/superpowers/specs/2026-05-17-llm-code-sandbox-tool-design.md`

---

## File Structure

| 路径 | 状态 | 职责 |
|---|---|---|
| `src/plugins/llm/services/code-sandbox-runtime.ts` | 新建 | `CodeSandboxRuntime` 类：QuickJS 生命周期、console 注入、main 调用、超时/内存限制、返回值序列化 |
| `src/plugins/llm/tools/code-sandbox.ts` | 新建 | `CODE_SANDBOX_TOOL` 定义 + `buildCodeSandboxHandler` 工厂 |
| `src/plugins/llm/tools/index.ts` | 改 | 增加 `export * from './code-sandbox'` |
| `src/plugins/llm/index.tsx` | 改 | `Config` 加 `codeSandbox` 字段；ToolRegistry 注册段加 code-sandbox 注册 |
| `src/plugins/llm/__tests__/code-sandbox-runtime.test.ts` | 新建 | runtime 单元测试 |
| `src/plugins/llm/__tests__/code-sandbox-tool.test.ts` | 新建 | tool handler 集成测试（mock ToolContext） |
| `package.json` | 改 | 加 `quickjs-emscripten` 依赖 |

---

## Task 1: 装依赖 + 起骨架文件（不破坏 build）

**Files:**
- Modify: `package.json`
- Create: `src/plugins/llm/services/code-sandbox-runtime.ts`
- Create: `src/plugins/llm/tools/code-sandbox.ts`
- Create: `src/plugins/llm/__tests__/code-sandbox-runtime.test.ts`

- [ ] **Step 1.1: 装 quickjs-emscripten**

Run:
```bash
bun add quickjs-emscripten
```

Expected: 装上最新 0.x 版本；`package.json` 出现该依赖；`bun.lock` 更新。

- [ ] **Step 1.2: 写 runtime 骨架（占位实现，让导入能编译）**

Create `src/plugins/llm/services/code-sandbox-runtime.ts`:

```ts
import type { Logger } from 'koishi'

export interface CodeSandboxRuntimeConfig {
  memoryLimitMb?: number
  defaultTimeoutMs?: number
  maxTimeoutMs?: number
  stdoutByteLimit?: number
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
}

export class CodeSandboxRuntime {
  private cfg: Required<CodeSandboxRuntimeConfig>

  constructor(
    private logger: Logger,
    cfg: CodeSandboxRuntimeConfig = {}
  ) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg }
  }

  async run(code: string, opts: RunOptions = {}): Promise<CodeSandboxResult> {
    throw new Error('not implemented')
  }
}
```

- [ ] **Step 1.3: 写 tool 骨架**

Create `src/plugins/llm/tools/code-sandbox.ts`:

```ts
import type { Logger } from 'koishi'

import type { ToolDefinition } from '../providers/_base'
import {
  CodeSandboxRuntime,
  type CodeSandboxRuntimeConfig,
} from '../services/code-sandbox-runtime'

import type { ToolHandler } from './types'

export const CODE_SANDBOX_TOOL: ToolDefinition = {
  name: 'run_code_sandbox',
  description: 'placeholder — will be filled in Task 10',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string' },
      timeout_ms: { type: 'integer', minimum: 100, maximum: 10000 },
    },
    required: ['code'],
    additionalProperties: false,
  },
}

export function buildCodeSandboxHandler(
  logger: Logger,
  config: CodeSandboxRuntimeConfig = {}
): ToolHandler {
  const runtime = new CodeSandboxRuntime(logger, config)
  return {
    definition: CODE_SANDBOX_TOOL,
    async execute() {
      throw new Error('not implemented')
    },
  }
}
```

- [ ] **Step 1.4: 写测试骨架**

Create `src/plugins/llm/__tests__/code-sandbox-runtime.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Logger } from 'koishi'

import { CodeSandboxRuntime } from '../services/code-sandbox-runtime'

const silentLogger = new Logger('test-code-sandbox')
silentLogger.silent = true

describe('CodeSandboxRuntime', () => {
  it('placeholder', () => {
    const r = new CodeSandboxRuntime(silentLogger)
    expect(r).toBeDefined()
  })
})
```

- [ ] **Step 1.5: 跑骨架测试 + typecheck**

Run:
```bash
bun run vitest run src/plugins/llm/__tests__/code-sandbox-runtime.test.ts
```

Expected: 1 passing test.

Run:
```bash
bun run tsc --noEmit
```

Expected: 无类型错误。

- [ ] **Step 1.6: Commit**

```bash
git add package.json bun.lock src/plugins/llm/services/code-sandbox-runtime.ts src/plugins/llm/tools/code-sandbox.ts src/plugins/llm/__tests__/code-sandbox-runtime.test.ts
git commit -m "$(cat <<'EOF'
feat(llm): scaffold code-sandbox tool skeleton

Add CodeSandboxRuntime service and tool wrapper as empty shells.
Wire quickjs-emscripten dependency. No registration yet — runtime
methods throw "not implemented" pending TDD fill-in.

Via Claude Code
Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: TDD — 基础同步 main 调用

**Files:**
- Modify: `src/plugins/llm/services/code-sandbox-runtime.ts`
- Modify: `src/plugins/llm/__tests__/code-sandbox-runtime.test.ts`

- [ ] **Step 2.1: 写 failing test — sync main 返回 number**

Append to `src/plugins/llm/__tests__/code-sandbox-runtime.test.ts`:

```ts
describe('sync main', () => {
  it('runs sync function main returning a number', async () => {
    const r = new CodeSandboxRuntime(silentLogger)
    const result = await r.run('function main() { return 1 + 1 }')
    expect(result.errorMessage).toBeUndefined()
    expect(result.returnValue).toBe('2')
    expect(result.stdout).toBe('')
  })
})
```

- [ ] **Step 2.2: 跑测试，确认 fail**

Run:
```bash
bun run vitest run src/plugins/llm/__tests__/code-sandbox-runtime.test.ts -t "sync function main"
```

Expected: FAIL with "not implemented".

- [ ] **Step 2.3: 实现 minimal run()**

Replace `run()` body in `src/plugins/llm/services/code-sandbox-runtime.ts`:

```ts
async run(code: string, opts: RunOptions = {}): Promise<CodeSandboxResult> {
  const { getQuickJS } = await import('quickjs-emscripten')
  const QuickJS = await getQuickJS()
  const runtime = QuickJS.newRuntime()
  const vm = runtime.newContext()
  const startedAt = Date.now()

  try {
    const evalResult = vm.evalCode(code)
    if (evalResult.error) {
      const errInfo = vm.dump(evalResult.error)
      evalResult.error.dispose()
      return {
        stdout: '',
        returnValue: undefined,
        errorMessage: `Error: ${formatVmError(errInfo)}`,
        durationMs: Date.now() - startedAt,
      }
    }
    evalResult.value.dispose()

    const mainHandle = vm.getProp(vm.global, 'main')
    try {
      if (vm.typeof(mainHandle) !== 'function') {
        return {
          stdout: '',
          returnValue: undefined,
          errorMessage:
            'Error: sandbox requires a top-level "function main()" entry (sync or async)',
          durationMs: Date.now() - startedAt,
        }
      }
      const callResult = vm.callFunction(mainHandle, vm.undefined)
      if (callResult.error) {
        const errInfo = vm.dump(callResult.error)
        callResult.error.dispose()
        return {
          stdout: '',
          returnValue: undefined,
          errorMessage: `Error: ${formatVmError(errInfo)}`,
          durationMs: Date.now() - startedAt,
        }
      }
      const returnHandle = callResult.value
      const nativeReturn = vm.dump(returnHandle)
      returnHandle.dispose()
      return {
        stdout: '',
        returnValue: serializeReturnValue(nativeReturn),
        errorMessage: undefined,
        durationMs: Date.now() - startedAt,
      }
    } finally {
      mainHandle.dispose()
    }
  } finally {
    vm.dispose()
    runtime.dispose()
  }
}
```

Add these helpers at the top of the same file (above the class):

```ts
function serializeReturnValue(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'string') return value as string
  if (t === 'boolean' || t === 'number' || t === 'bigint') return String(value)
  return JSON.stringify(value, null, 2)
}

function formatVmError(errInfo: unknown): string {
  if (errInfo && typeof errInfo === 'object') {
    const e = errInfo as { name?: string; message?: string; stack?: string }
    const head = `${e.name ?? 'Error'}: ${e.message ?? ''}`.trim()
    return head
  }
  return String(errInfo)
}
```

- [ ] **Step 2.4: 跑测试，确认 pass**

Run:
```bash
bun run vitest run src/plugins/llm/__tests__/code-sandbox-runtime.test.ts
```

Expected: all passing (placeholder + sync main).

- [ ] **Step 2.5: Commit**

```bash
git add src/plugins/llm/services/code-sandbox-runtime.ts src/plugins/llm/__tests__/code-sandbox-runtime.test.ts
git commit -m "feat(llm): code-sandbox runtime supports sync main()

Via Claude Code
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: TDD — 入口校验（缺失 main / main 类型错）

**Files:**
- Modify: `src/plugins/llm/__tests__/code-sandbox-runtime.test.ts`

(Runtime 已经实现了这两个分支，本任务只确认它们被测试覆盖。)

- [ ] **Step 3.1: 写测试**

Append:

```ts
describe('entry validation', () => {
  it('rejects code with no main defined', async () => {
    const r = new CodeSandboxRuntime(silentLogger)
    const result = await r.run('const x = 1')
    expect(result.errorMessage).toContain('requires a top-level "function main()"')
    expect(result.returnValue).toBeUndefined()
  })

  it('rejects code where main is not a function', async () => {
    const r = new CodeSandboxRuntime(silentLogger)
    const result = await r.run('const main = 42')
    expect(result.errorMessage).toContain('requires a top-level "function main()"')
  })
})
```

- [ ] **Step 3.2: 跑测试，确认 pass**

Run:
```bash
bun run vitest run src/plugins/llm/__tests__/code-sandbox-runtime.test.ts -t "entry validation"
```

Expected: both pass.

- [ ] **Step 3.3: Commit**

```bash
git add src/plugins/llm/__tests__/code-sandbox-runtime.test.ts
git commit -m "test(llm): code-sandbox entry validation cases

Via Claude Code
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: TDD — SyntaxError 友好报错

**Files:**
- Modify: `src/plugins/llm/__tests__/code-sandbox-runtime.test.ts`

- [ ] **Step 4.1: 写测试**

Append:

```ts
describe('syntax errors', () => {
  it('returns SyntaxError with line context for unparseable code', async () => {
    const r = new CodeSandboxRuntime(silentLogger)
    const result = await r.run('function main() { return 1 +')
    expect(result.errorMessage).toMatch(/^Error: SyntaxError:/)
    expect(result.returnValue).toBeUndefined()
  })
})
```

- [ ] **Step 4.2: 跑测试**

Run:
```bash
bun run vitest run src/plugins/llm/__tests__/code-sandbox-runtime.test.ts -t "syntax errors"
```

Expected: PASS (`formatVmError` 已经把 name+message 拼出来；QuickJS 的 SyntaxError 自带 line/column 在 message 里)。若 fail（QuickJS 报错格式不带 line），调整 `formatVmError` 把 `errInfo.stack` 第一行也拼上。

- [ ] **Step 4.3: Commit**

```bash
git add src/plugins/llm/__tests__/code-sandbox-runtime.test.ts
git commit -m "test(llm): code-sandbox surfaces SyntaxError messages

Via Claude Code
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: TDD — 返回值序列化各分支

**Files:**
- Modify: `src/plugins/llm/__tests__/code-sandbox-runtime.test.ts`

- [ ] **Step 5.1: 写测试**

Append:

```ts
describe('return value serialization', () => {
  it('string returned as-is without quotes', async () => {
    const r = new CodeSandboxRuntime(silentLogger)
    const result = await r.run('function main() { return "hello world" }')
    expect(result.returnValue).toBe('hello world')
  })

  it('null returned as "null"', async () => {
    const r = new CodeSandboxRuntime(silentLogger)
    const result = await r.run('function main() { return null }')
    expect(result.returnValue).toBe('null')
  })

  it('boolean returned as string', async () => {
    const r = new CodeSandboxRuntime(silentLogger)
    const result = await r.run('function main() { return true }')
    expect(result.returnValue).toBe('true')
  })

  it('undefined return → no return value section', async () => {
    const r = new CodeSandboxRuntime(silentLogger)
    const result = await r.run('function main() {}')
    expect(result.returnValue).toBeUndefined()
    expect(result.errorMessage).toBeUndefined()
  })

  it('object returned as pretty JSON', async () => {
    const r = new CodeSandboxRuntime(silentLogger)
    const result = await r.run('function main() { return {a:1,b:[2,3]} }')
    expect(result.returnValue).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}')
  })
})
```

- [ ] **Step 5.2: 跑测试**

Run:
```bash
bun run vitest run src/plugins/llm/__tests__/code-sandbox-runtime.test.ts -t "return value serialization"
```

Expected: all PASS.

- [ ] **Step 5.3: Commit**

```bash
git add src/plugins/llm/__tests__/code-sandbox-runtime.test.ts
git commit -m "test(llm): code-sandbox return value serialization coverage

Via Claude Code
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: TDD — 大对象截断 + 循环引用 fallback

**Files:**
- Modify: `src/plugins/llm/services/code-sandbox-runtime.ts`
- Modify: `src/plugins/llm/__tests__/code-sandbox-runtime.test.ts`

- [ ] **Step 6.1: 写 failing tests**

Append:

```ts
describe('return value edge cases', () => {
  it('truncates large object output', async () => {
    const r = new CodeSandboxRuntime(silentLogger)
    const result = await r.run(
      'function main() { return Array.from({length: 1000}, (_, i) => ({i, s: "x".repeat(20)})) }'
    )
    expect(result.errorMessage).toBeUndefined()
    expect(result.returnValue).toBeDefined()
    expect(result.returnValue!.length).toBeLessThan(5000) // 4096 cap + tail
    expect(result.returnValue!).toMatch(/\(truncated/)
  })

  it('falls back to String() for circular references', async () => {
    const r = new CodeSandboxRuntime(silentLogger)
    const result = await r.run(
      'function main() { const a = {}; a.self = a; return a }'
    )
    expect(result.errorMessage).toBeUndefined()
    expect(result.returnValue).toMatch(/non-JSON parts/)
  })
})
```

- [ ] **Step 6.2: 跑测试，确认 fail**

Run:
```bash
bun run vitest run src/plugins/llm/__tests__/code-sandbox-runtime.test.ts -t "return value edge cases"
```

Expected: FAIL (no truncation; throws on circular).

- [ ] **Step 6.3: 改进 serializer**

Replace `serializeReturnValue` in `src/plugins/llm/services/code-sandbox-runtime.ts`:

```ts
const RETURN_VALUE_BYTE_CAP = 4096

function serializeReturnValue(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'string') return value as string
  if (t === 'boolean' || t === 'number' || t === 'bigint') return String(value)

  let json: string
  try {
    json = JSON.stringify(value, null, 2)
    if (json === undefined) {
      return `${String(value)} (note: value contains non-JSON parts)`
    }
  } catch {
    return `${String(value)} (note: value contains non-JSON parts)`
  }

  const byteLen = Buffer.byteLength(json, 'utf8')
  if (byteLen <= RETURN_VALUE_BYTE_CAP) return json
  const sliced = json.slice(0, RETURN_VALUE_BYTE_CAP)
  return `${sliced}\n... (truncated, ${(byteLen / 1024).toFixed(1)}KB total)`
}
```

Note: `JSON.stringify` on a circular reference throws `TypeError`. On objects with non-JSON-serializable parts (functions, symbols), it returns `undefined` for the top-level — both branches handled above.

- [ ] **Step 6.4: 跑测试**

Run:
```bash
bun run vitest run src/plugins/llm/__tests__/code-sandbox-runtime.test.ts -t "return value edge cases"
```

Expected: both PASS.

- [ ] **Step 6.5: Commit**

```bash
git add src/plugins/llm/services/code-sandbox-runtime.ts src/plugins/llm/__tests__/code-sandbox-runtime.test.ts
git commit -m "feat(llm): code-sandbox truncates large objects, handles circular refs

Via Claude Code
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: TDD — console 注入 + stdout 累积

**Files:**
- Modify: `src/plugins/llm/services/code-sandbox-runtime.ts`
- Modify: `src/plugins/llm/__tests__/code-sandbox-runtime.test.ts`

- [ ] **Step 7.1: 写 failing tests**

Append:

```ts
describe('console injection', () => {
  it('captures console.log with [log] prefix', async () => {
    const r = new CodeSandboxRuntime(silentLogger)
    const result = await r.run(`
      function main() {
        console.log('hello', 'world')
        console.log(42)
        return 'done'
      }
    `)
    expect(result.errorMessage).toBeUndefined()
    expect(result.stdout).toBe('[log] hello world\n[log] 42\n')
    expect(result.returnValue).toBe('done')
  })

  it('captures console.warn and console.error with correct prefixes', async () => {
    const r = new CodeSandboxRuntime(silentLogger)
    const result = await r.run(`
      function main() {
        console.warn('warn-msg')
        console.error('err-msg')
      }
    `)
    expect(result.stdout).toBe('[warn] warn-msg\n[error] err-msg\n')
  })

  it('serializes object arguments via JSON.stringify', async () => {
    const r = new CodeSandboxRuntime(silentLogger)
    const result = await r.run(`
      function main() { console.log({a: 1}) }
    `)
    expect(result.stdout).toBe('[log] {"a":1}\n')
  })
})
```

- [ ] **Step 7.2: 跑测试，确认 fail**

Run:
```bash
bun run vitest run src/plugins/llm/__tests__/code-sandbox-runtime.test.ts -t "console injection"
```

Expected: FAIL (sandbox has no console).

- [ ] **Step 7.3: 实现 console 注入**

Modify `src/plugins/llm/services/code-sandbox-runtime.ts` — add this helper above the class:

```ts
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
```

Then, in `run()`, after `const vm = runtime.newContext()` but before `vm.evalCode(code)`, install the console:

```ts
const stdoutChunks: string[] = []
let stdoutBytes = 0
let stdoutTruncated = false
const appendStdout = (line: string) => {
  if (stdoutTruncated) return
  const bytes = Buffer.byteLength(line, 'utf8')
  if (stdoutBytes + bytes > this.cfg.stdoutByteLimit) {
    stdoutTruncated = true
    stdoutChunks.push(`... (stdout truncated at ${stdoutBytes} bytes)\n`)
    return
  }
  stdoutChunks.push(line)
  stdoutBytes += bytes
}

const makeLogFn = (prefix: string) =>
  vm.newFunction(prefix, (...handles) => {
    const parts = handles.map((h) => formatConsoleArg(vm.dump(h)))
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
```

Finally, in **every** `return { ... }` inside `run()`, replace the `stdout: ''` field with `stdout: stdoutChunks.join('')`. Six call sites to update (sync main path: eval-error, missing-main, call-error, success; will become more after Task 8).

- [ ] **Step 7.4: 跑测试**

Run:
```bash
bun run vitest run src/plugins/llm/__tests__/code-sandbox-runtime.test.ts
```

Expected: all PASS.

- [ ] **Step 7.5: Commit**

```bash
git add src/plugins/llm/services/code-sandbox-runtime.ts src/plugins/llm/__tests__/code-sandbox-runtime.test.ts
git commit -m "feat(llm): code-sandbox injects console + collects stdout

Via Claude Code
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: TDD — stdout 截断

**Files:**
- Modify: `src/plugins/llm/__tests__/code-sandbox-runtime.test.ts`

(截断逻辑已在 Task 7 写入；本任务补测试。)

- [ ] **Step 8.1: 写测试**

Append:

```ts
describe('stdout truncation', () => {
  it('truncates stdout past byte limit', async () => {
    const r = new CodeSandboxRuntime(silentLogger, { stdoutByteLimit: 200 })
    const result = await r.run(`
      function main() {
        for (let i = 0; i < 100; i++) console.log('x'.repeat(50))
      }
    `)
    expect(result.stdout).toMatch(/stdout truncated at \d+ bytes/)
    expect(result.stdout.length).toBeLessThan(400)
  })
})
```

- [ ] **Step 8.2: 跑测试**

Run:
```bash
bun run vitest run src/plugins/llm/__tests__/code-sandbox-runtime.test.ts -t "stdout truncation"
```

Expected: PASS.

- [ ] **Step 8.3: Commit**

```bash
git add src/plugins/llm/__tests__/code-sandbox-runtime.test.ts
git commit -m "test(llm): code-sandbox stdout truncation

Via Claude Code
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: TDD — async main + Promise resolution

**Files:**
- Modify: `src/plugins/llm/services/code-sandbox-runtime.ts`
- Modify: `src/plugins/llm/__tests__/code-sandbox-runtime.test.ts`

- [ ] **Step 9.1: 写 failing tests**

Append:

```ts
describe('async main', () => {
  it('awaits async main returning a Promise', async () => {
    const r = new CodeSandboxRuntime(silentLogger)
    const result = await r.run(`
      async function main() { return await Promise.resolve(42) }
    `)
    expect(result.errorMessage).toBeUndefined()
    expect(result.returnValue).toBe('42')
  })

  it('handles main returning a manually constructed Promise', async () => {
    const r = new CodeSandboxRuntime(silentLogger)
    const result = await r.run(`
      function main() {
        return new Promise(resolve => resolve('done'))
      }
    `)
    expect(result.returnValue).toBe('done')
  })
})
```

- [ ] **Step 9.2: 跑测试，确认 fail**

Run:
```bash
bun run vitest run src/plugins/llm/__tests__/code-sandbox-runtime.test.ts -t "async main"
```

Expected: FAIL — currently returns `'{}'` (the Promise handle dumped as empty object) or similar non-string.

- [ ] **Step 9.3: 实现 Promise resolution**

In `run()`, replace the success branch (after `callResult.value` is obtained) with:

```ts
const returnHandle = callResult.value
let resolvedHandle = returnHandle
let needDisposeResolved = false
try {
  // If main returned a Promise, await it. resolvePromise also handles
  // non-Promise values transparently (it just wraps + resolves immediately).
  const typeName = vm.typeof(returnHandle)
  if (typeName === 'object') {
    // Peek: if the value has a .then function, treat as Promise.
    const thenHandle = vm.getProp(returnHandle, 'then')
    const isThenable = vm.typeof(thenHandle) === 'function'
    thenHandle.dispose()
    if (isThenable) {
      const promise = vm.resolvePromise(returnHandle)
      runtime.executePendingJobs()
      const settled = await promise
      returnHandle.dispose()
      if (settled.error) {
        const errInfo = vm.dump(settled.error)
        settled.error.dispose()
        return {
          stdout: stdoutChunks.join(''),
          returnValue: undefined,
          errorMessage: `Error: ${formatVmError(errInfo)}`,
          durationMs: Date.now() - startedAt,
        }
      }
      resolvedHandle = settled.value
      needDisposeResolved = true
    }
  }
  const nativeReturn = vm.dump(resolvedHandle)
  if (needDisposeResolved) resolvedHandle.dispose()
  else returnHandle.dispose()
  return {
    stdout: stdoutChunks.join(''),
    returnValue: serializeReturnValue(nativeReturn),
    errorMessage: undefined,
    durationMs: Date.now() - startedAt,
  }
} catch (e: any) {
  if (needDisposeResolved) resolvedHandle.dispose()
  else returnHandle.dispose()
  throw e
}
```

- [ ] **Step 9.4: 跑测试**

Run:
```bash
bun run vitest run src/plugins/llm/__tests__/code-sandbox-runtime.test.ts -t "async main"
```

Expected: both PASS.

Also re-run full suite to confirm no regression:

```bash
bun run vitest run src/plugins/llm/__tests__/code-sandbox-runtime.test.ts
```

Expected: all PASS.

- [ ] **Step 9.5: Commit**

```bash
git add src/plugins/llm/services/code-sandbox-runtime.ts src/plugins/llm/__tests__/code-sandbox-runtime.test.ts
git commit -m "feat(llm): code-sandbox supports async main + Promise return

Via Claude Code
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: TDD — 超时

**Files:**
- Modify: `src/plugins/llm/services/code-sandbox-runtime.ts`
- Modify: `src/plugins/llm/__tests__/code-sandbox-runtime.test.ts`

- [ ] **Step 10.1: 写 failing test**

Append:

```ts
describe('timeout', () => {
  it('aborts infinite loop with timeout error', async () => {
    const r = new CodeSandboxRuntime(silentLogger)
    const result = await r.run(
      'function main() { while (true) {} }',
      { timeoutMs: 200 }
    )
    expect(result.errorMessage).toMatch(/timed out after 200ms/)
    expect(result.returnValue).toBeUndefined()
  }, 5000)
})
```

- [ ] **Step 10.2: 跑测试，确认 fail（会真挂住或超过 vitest 测试超时）**

Run:
```bash
bun run vitest run src/plugins/llm/__tests__/code-sandbox-runtime.test.ts -t "timeout" --testTimeout=5000
```

Expected: FAIL — test times out at 5s because no interrupt handler.

- [ ] **Step 10.3: 实现 setInterruptHandler + 计算 deadline**

In `run()`, near the top (after `const startedAt = Date.now()`), add:

```ts
const timeoutMs = Math.min(
  Math.max(opts.timeoutMs ?? this.cfg.defaultTimeoutMs, 1),
  this.cfg.maxTimeoutMs
)
const deadline = startedAt + timeoutMs
runtime.setInterruptHandler(() => Date.now() > deadline)
```

Then in the error-handling branch of either `evalResult.error` or `callResult.error`, detect the timeout: if `Date.now() > deadline`, override `errorMessage` to `Error: execution timed out after ${timeoutMs}ms`. Implementation: add a helper at file top:

```ts
function isTimeoutError(deadline: number): boolean {
  return Date.now() > deadline
}
```

In each of the three error-return sites (eval-error, call-error, Promise rejection), wrap:

```ts
const errInfo = vm.dump(<errorHandle>)
<errorHandle>.dispose()
const errorMessage = isTimeoutError(deadline)
  ? `Error: execution timed out after ${timeoutMs}ms`
  : `Error: ${formatVmError(errInfo)}`
return {
  stdout: stdoutChunks.join(''),
  returnValue: undefined,
  errorMessage,
  durationMs: Date.now() - startedAt,
}
```

- [ ] **Step 10.4: 跑测试**

Run:
```bash
bun run vitest run src/plugins/llm/__tests__/code-sandbox-runtime.test.ts -t "timeout" --testTimeout=5000
```

Expected: PASS within ~250ms.

Re-run full suite:

```bash
bun run vitest run src/plugins/llm/__tests__/code-sandbox-runtime.test.ts
```

Expected: all PASS.

- [ ] **Step 10.5: Commit**

```bash
git add src/plugins/llm/services/code-sandbox-runtime.ts src/plugins/llm/__tests__/code-sandbox-runtime.test.ts
git commit -m "feat(llm): code-sandbox enforces wall-clock timeout

Via Claude Code
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 11: TDD — 内存限制

**Files:**
- Modify: `src/plugins/llm/services/code-sandbox-runtime.ts`
- Modify: `src/plugins/llm/__tests__/code-sandbox-runtime.test.ts`

- [ ] **Step 11.1: 写 failing test**

Append:

```ts
describe('memory limit', () => {
  it('rejects allocation past memory limit', async () => {
    const r = new CodeSandboxRuntime(silentLogger, { memoryLimitMb: 4 })
    const result = await r.run(`
      function main() {
        const arr = []
        for (let i = 0; i < 1_000_000; i++) arr.push({a: i, b: 'x'.repeat(100)})
        return arr.length
      }
    `)
    expect(result.errorMessage).toBeDefined()
    expect(result.errorMessage).toMatch(/memory|out of memory/i)
  }, 10000)
})
```

- [ ] **Step 11.2: 跑测试，确认 fail（无内存限制 → 可能 OOM 或 vitest hang）**

Run:
```bash
bun run vitest run src/plugins/llm/__tests__/code-sandbox-runtime.test.ts -t "memory limit" --testTimeout=10000
```

Expected: FAIL — either succeeds (no limit) or times out (allocation eventually completes).

- [ ] **Step 11.3: 实现 setMemoryLimit + setMaxStackSize + memory error 归类**

In `run()`, right after `const runtime = QuickJS.newRuntime()`:

```ts
runtime.setMemoryLimit(this.cfg.memoryLimitMb * 1024 * 1024)
runtime.setMaxStackSize(256 * 1024)
```

Add helper:

```ts
function isMemoryError(errInfo: unknown): boolean {
  const msg =
    errInfo && typeof errInfo === 'object'
      ? String((errInfo as { message?: string }).message ?? '')
      : String(errInfo)
  return /out of memory/i.test(msg)
}
```

In the same three error-return sites, refine:

```ts
let errorMessage: string
if (isTimeoutError(deadline)) {
  errorMessage = `Error: execution timed out after ${timeoutMs}ms`
} else if (isMemoryError(errInfo)) {
  errorMessage = 'Error: memory limit exceeded'
} else {
  errorMessage = `Error: ${formatVmError(errInfo)}`
}
```

- [ ] **Step 11.4: 跑测试**

Run:
```bash
bun run vitest run src/plugins/llm/__tests__/code-sandbox-runtime.test.ts -t "memory limit" --testTimeout=10000
```

Expected: PASS quickly (allocation fails fast at ~4MB).

Re-run full suite:

```bash
bun run vitest run src/plugins/llm/__tests__/code-sandbox-runtime.test.ts
```

Expected: all PASS.

- [ ] **Step 11.5: Commit**

```bash
git add src/plugins/llm/services/code-sandbox-runtime.ts src/plugins/llm/__tests__/code-sandbox-runtime.test.ts
git commit -m "feat(llm): code-sandbox enforces memory + stack limits

Via Claude Code
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 12: TDD — 隔离（无 fetch / process / require / setTimeout）

**Files:**
- Modify: `src/plugins/llm/__tests__/code-sandbox-runtime.test.ts`

(QuickJS 默认不提供这些 host API；本任务只是验证。)

- [ ] **Step 12.1: 写测试**

Append:

```ts
describe('isolation', () => {
  it.each([
    ['fetch', 'fetch("https://example.com")'],
    ['process', 'process.exit(1)'],
    ['require', 'require("fs")'],
    ['setTimeout', 'setTimeout(() => {}, 0)'],
    ['XMLHttpRequest', 'new XMLHttpRequest()'],
    ['Bun', 'Bun.spawn(["ls"])'],
    ['Deno', 'Deno.readFile("/etc/hosts")'],
  ])('rejects access to host API: %s', async (_, snippet) => {
    const r = new CodeSandboxRuntime(silentLogger)
    const result = await r.run(`function main() { ${snippet} }`)
    expect(result.errorMessage).toMatch(/ReferenceError|not defined|TypeError/)
  })
})
```

- [ ] **Step 12.2: 跑测试**

Run:
```bash
bun run vitest run src/plugins/llm/__tests__/code-sandbox-runtime.test.ts -t "isolation"
```

Expected: all 7 PASS.

If any fails (i.e. QuickJS does provide one of them as a global), document the discrepancy in the spec's Non-Goals and adjust test expectation. Do NOT add code to delete the global — if QuickJS provides it, there's a reason; investigate first.

- [ ] **Step 12.3: Commit**

```bash
git add src/plugins/llm/__tests__/code-sandbox-runtime.test.ts
git commit -m "test(llm): code-sandbox verifies isolation from host APIs

Via Claude Code
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 13: 测试 BigInt + 原生 Math + 原生 Date 可用

**Files:**
- Modify: `src/plugins/llm/__tests__/code-sandbox-runtime.test.ts`

- [ ] **Step 13.1: 写测试**

Append:

```ts
describe('native ECMAScript builtins available', () => {
  it('Math.sqrt works', async () => {
    const r = new CodeSandboxRuntime(silentLogger)
    const result = await r.run('function main() { return Math.sqrt(2) }')
    expect(parseFloat(result.returnValue!)).toBeCloseTo(1.41421356, 6)
  })

  it('Date works', async () => {
    const r = new CodeSandboxRuntime(silentLogger)
    const result = await r.run(
      'function main() { return new Date("2024-01-01T00:00:00Z").toISOString() }'
    )
    expect(result.returnValue).toBe('2024-01-01T00:00:00.000Z')
  })

  it('BigInt works', async () => {
    const r = new CodeSandboxRuntime(silentLogger)
    const result = await r.run('function main() { return (2n ** 64n).toString() }')
    expect(result.returnValue).toBe('18446744073709551616')
  })
})
```

- [ ] **Step 13.2: 跑测试**

Run:
```bash
bun run vitest run src/plugins/llm/__tests__/code-sandbox-runtime.test.ts -t "native ECMAScript"
```

Expected: all PASS.

Note: BigInt test returns `.toString()` instead of the bigint itself because `vm.dump` on a bigint handle may or may not preserve it across the WASM boundary — using `.toString()` removes that ambiguity for this test.

- [ ] **Step 13.3: Commit**

```bash
git add src/plugins/llm/__tests__/code-sandbox-runtime.test.ts
git commit -m "test(llm): code-sandbox verifies native ECMAScript builtins

Via Claude Code
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 14: 实现 tool handler + markdown 输出

**Files:**
- Modify: `src/plugins/llm/tools/code-sandbox.ts`
- Create: `src/plugins/llm/__tests__/code-sandbox-tool.test.ts`

- [ ] **Step 14.1: 写 tool description + 完整 handler**

Replace `src/plugins/llm/tools/code-sandbox.ts` with:

```ts
import type { Logger } from 'koishi'

import type { ToolDefinition } from '../providers/_base'
import {
  CodeSandboxRuntime,
  type CodeSandboxRuntimeConfig,
  type CodeSandboxResult,
} from '../services/code-sandbox-runtime'

import type { ToolHandler } from './types'

export const CODE_SANDBOX_TOOL: ToolDefinition = {
  name: 'run_code_sandbox',
  description: [
    '在隔离 JS 沙箱里运行一段代码做数学/数据处理类工作。**不联网、不读盘**。',
    '',
    '**入口契约**：必须定义且只定义一个 `function main() {}`，sync / async 均可。',
    '`return` 的值会被序列化展示给用户；过程信息用 console.log/warn/error。',
    '',
    '**沙箱环境**：',
    '- 语言能力：QuickJS（WASM），最高支持到 **ES2023**（async/await、BigInt、Proxy、可选链、Promise.allSettled 等可用；ES2024+ 的特性如 Temporal、Array Grouping 不可用）',
    '- 全局可用：标准内建对象（Math / Date / JSON / Array / Object / Map / Set / Promise / RegExp / BigInt 等）+ 注入的 `console`',
    '- **没有任何第三方库**（mathjs / dayjs / lodash 都不可用）；复杂算法请自己实现',
    '- 沙箱内**没有** fetch / XHR / WebSocket / setTimeout / setInterval / process / require / Bun / Deno',
    '- 可 `await` 立即 resolved 的 Promise / async 函数，但没有 host 异步源',
    '',
    '**何时调**：数值/统计计算、单位/进制转换、JSON/CSV 解析与转换、日期运算、文本批处理、需要程序化验证的逻辑。',
    '**何时别调**：能直接答的事实问题、能用 web_search/extract_webpages 解决的联网查询。',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description:
          '完整 JS 源码，必须包含 `function main() {}` 入口（sync / async 均可）',
      },
      timeout_ms: {
        type: 'integer',
        description: '执行超时（ms），默认 3000，上限 10000',
        minimum: 100,
        maximum: 10000,
      },
    },
    required: ['code'],
    additionalProperties: false,
  },
}

export interface CodeSandboxToolInput {
  code: string
  timeout_ms?: number
}

export function renderCodeSandboxResult(r: CodeSandboxResult): string {
  const parts: string[] = []
  if (r.stdout) {
    parts.push('### stdout', '```', r.stdout.replace(/\n$/, ''), '```')
  }
  if (r.errorMessage) {
    parts.push(r.errorMessage)
  } else if (r.returnValue !== undefined) {
    parts.push('### return', '```', r.returnValue, '```')
  } else if (!r.stdout) {
    parts.push('(no output)')
  }
  parts.push(`_(${r.durationMs}ms)_`)
  return parts.join('\n')
}

export function buildCodeSandboxHandler(
  logger: Logger,
  config: CodeSandboxRuntimeConfig = {}
): ToolHandler {
  const runtime = new CodeSandboxRuntime(logger, config)
  return {
    definition: CODE_SANDBOX_TOOL,
    async execute(args) {
      const input = args as CodeSandboxToolInput
      if (!input?.code || typeof input.code !== 'string') {
        return 'Error: tool input missing required field "code"'
      }
      const result = await runtime.run(input.code, {
        timeoutMs: input.timeout_ms,
      })
      return renderCodeSandboxResult(result)
    },
  }
}
```

- [ ] **Step 14.2: 写 tool 集成测试**

Create `src/plugins/llm/__tests__/code-sandbox-tool.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Logger } from 'koishi'

import {
  buildCodeSandboxHandler,
  renderCodeSandboxResult,
} from '../tools/code-sandbox'

const silentLogger = new Logger('test-code-sandbox-tool')
silentLogger.silent = true

const fakeToolCtx = {
  ctx: {} as any,
  logger: silentLogger,
  session: {} as any,
  turnState: {},
}

describe('buildCodeSandboxHandler', () => {
  it('returns markdown with stdout + return on success', async () => {
    const handler = buildCodeSandboxHandler(silentLogger)
    const out = await handler.execute(
      { code: 'function main() { console.log("hi"); return 7 }' },
      fakeToolCtx
    )
    expect(out).toContain('### stdout')
    expect(out).toContain('[log] hi')
    expect(out).toContain('### return')
    expect(out).toContain('7')
  })

  it('returns error message on failure', async () => {
    const handler = buildCodeSandboxHandler(silentLogger)
    const out = await handler.execute(
      { code: 'function main() { throw new Error("boom") }' },
      fakeToolCtx
    )
    expect(out).toContain('Error:')
    expect(out).toContain('boom')
  })

  it('rejects missing code arg', async () => {
    const handler = buildCodeSandboxHandler(silentLogger)
    const out = await handler.execute({} as any, fakeToolCtx)
    expect(out).toMatch(/missing required field "code"/)
  })

  it('respects timeout_ms input', async () => {
    const handler = buildCodeSandboxHandler(silentLogger)
    const out = await handler.execute(
      { code: 'function main() { while(true){} }', timeout_ms: 150 },
      fakeToolCtx
    )
    expect(out).toContain('timed out after 150ms')
  }, 5000)
})

describe('renderCodeSandboxResult', () => {
  it('omits "no output" when stdout or return present', () => {
    const out = renderCodeSandboxResult({
      stdout: '',
      returnValue: '42',
      errorMessage: undefined,
      durationMs: 5,
    })
    expect(out).toContain('### return')
    expect(out).not.toContain('no output')
  })

  it('shows "(no output)" when nothing returned and no stdout', () => {
    const out = renderCodeSandboxResult({
      stdout: '',
      returnValue: undefined,
      errorMessage: undefined,
      durationMs: 5,
    })
    expect(out).toContain('(no output)')
  })
})
```

- [ ] **Step 14.3: 跑两套测试**

Run:
```bash
bun run vitest run src/plugins/llm/__tests__/code-sandbox-runtime.test.ts src/plugins/llm/__tests__/code-sandbox-tool.test.ts
```

Expected: all PASS.

- [ ] **Step 14.4: Commit**

```bash
git add src/plugins/llm/tools/code-sandbox.ts src/plugins/llm/__tests__/code-sandbox-tool.test.ts
git commit -m "feat(llm): code-sandbox tool handler + markdown output

Via Claude Code
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 15: 集成到插件（注册 + 配置）

**Files:**
- Modify: `src/plugins/llm/tools/index.ts`
- Modify: `src/plugins/llm/index.tsx`

- [ ] **Step 15.1: 加 barrel export**

In `src/plugins/llm/tools/index.ts`, add this line in the export block:

```ts
export * from './code-sandbox'
```

So the file becomes:

```ts
export * from './types'
export * from './execute-koishi-command'
export * from './read-user-memory'
export * from './save-user-memory'
export * from './web'
export * from './code-sandbox'
```

- [ ] **Step 15.2: 加 Config 字段**

In `src/plugins/llm/index.tsx`, inside `export interface Config { ... }`, add (place it near the `tavily` field for visual grouping):

```ts
/**
 * Local QuickJS-based code sandbox tool. Default enabled; set
 * `{ enabled: false }` to disable. No external service / API key needed.
 */
codeSandbox?: {
  enabled?: boolean
  memoryLimitMb?: number
  maxTimeoutMs?: number
  defaultTimeoutMs?: number
  stdoutByteLimit?: number
}
```

- [ ] **Step 15.3: 更新 import + 注册**

In the same file, update the imports from `./tools` to include the new exports:

```ts
import {
  EXTRACT_WEBPAGES_TOOL,
  READ_USER_MEMORY_TOOL,
  ToolRegistry,
  WEB_SEARCH_TOOL,
  buildCodeSandboxHandler,
  buildSaveUserMemoryTool,
  executeKoishiCommandHandler,
  getMemoryToolState,
  getWebToolsState,
  runReadUserMemory,
  runSaveUserMemory,
  runWebExtract,
  runWebSearch,
} from './tools'
```

Then, in the constructor, **after** the tavily registration block but **before** `this.catalog.bind()`, add:

```ts
// code-sandbox: 本地 QuickJS 沙箱工具，默认开启（不需要 API key）
const sb = config.codeSandbox ?? {}
if (sb.enabled !== false) {
  this.tools.register(
    buildCodeSandboxHandler(this.logger, {
      memoryLimitMb: sb.memoryLimitMb,
      defaultTimeoutMs: sb.defaultTimeoutMs,
      maxTimeoutMs: sb.maxTimeoutMs,
      stdoutByteLimit: sb.stdoutByteLimit,
    })
  )
}
```

- [ ] **Step 15.4: Typecheck + 全量测试**

Run:
```bash
bun run tsc --noEmit
```

Expected: no errors.

Run:
```bash
bun run vitest run
```

Expected: all tests pass (existing + new sandbox tests).

- [ ] **Step 15.5: Commit**

```bash
git add src/plugins/llm/tools/index.ts src/plugins/llm/index.tsx
git commit -m "feat(llm): register code-sandbox tool in plugin

Via Claude Code
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 16: 冷启动预热（可选优化）

**Files:**
- Modify: `src/plugins/llm/services/code-sandbox-runtime.ts`
- Modify: `src/plugins/llm/index.tsx`

- [ ] **Step 16.1: 加 warmup() 方法**

In `src/plugins/llm/services/code-sandbox-runtime.ts`, add a method to `CodeSandboxRuntime`:

```ts
/** Load + drop a context once so the WASM module is cached. Idempotent. */
async warmup(): Promise<void> {
  const { getQuickJS } = await import('quickjs-emscripten')
  const QuickJS = await getQuickJS()
  const rt = QuickJS.newRuntime()
  const vm = rt.newContext()
  vm.dispose()
  rt.dispose()
}
```

- [ ] **Step 16.2: 在 ready hook 触发**

In `src/plugins/llm/index.tsx`, **inside the existing `this.ctx.on('ready', () => { ... })` callback**, append (after the image-cache setup):

```ts
// 预热 code-sandbox WASM，把首次 tool call 的 ~100-200ms 加载延迟从
// 用户感知路径里移走。失败不影响主流程（第一次实际调用会重新尝试加载）。
const sbHandler = this.tools.get('run_code_sandbox')
if (sbHandler) {
  ;(async () => {
    try {
      const { CodeSandboxRuntime } = await import(
        './services/code-sandbox-runtime'
      )
      await new CodeSandboxRuntime(this.logger).warmup()
      this.logger.info('[code-sandbox] warmup ok')
    } catch (e) {
      this.logger.warn('[code-sandbox] warmup failed:', e)
    }
  })()
}
```

Note: this uses `this.tools.get()`. Verify `ToolRegistry` has a public `get` method (it does — see `tools/types.ts:35-37`).

- [ ] **Step 16.3: Typecheck + 全量测试**

Run:
```bash
bun run tsc --noEmit && bun run vitest run
```

Expected: all pass.

- [ ] **Step 16.4: Commit**

```bash
git add src/plugins/llm/services/code-sandbox-runtime.ts src/plugins/llm/index.tsx
git commit -m "perf(llm): warm up code-sandbox WASM at plugin ready

Via Claude Code
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 17: 收尾 — 全量验证

**Files:** none (verification only)

- [ ] **Step 17.1: 全量测试**

Run:
```bash
bun run vitest run
```

Expected: 100% pass, no skipped tests in code-sandbox suites.

- [ ] **Step 17.2: Typecheck**

Run:
```bash
bun run tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 17.3: 实际启动 SILI 检查注册**

Run:
```bash
bun start
```

(let it boot for ~10 seconds, look for `[code-sandbox] warmup ok` line in the log)

Expected: no startup errors; warmup line appears; SILI 正常运行。

Stop with Ctrl+C.

If you can't run `bun start` (no DB / no env), say so explicitly — do **not** silently skip this step.

- [ ] **Step 17.4: 报告**

Summarize：
- 测试条数（runtime + tool 两个套件之和）
- 是否有需要 spec/plan 注释的差异（例如 isolation 测试里发现 QuickJS 实际提供了某个 host API，或者 timeout 误差比预期大）
- 实际跑出来的 WASM cold-start 用时（warmup log 前后时间差）

No commit needed.
