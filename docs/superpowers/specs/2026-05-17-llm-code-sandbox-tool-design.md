# LLM Plugin: Code Sandbox Tool 设计

## Goal

给 `src/plugins/llm` 的 agent 增加一个 `run_code_sandbox` 工具，让 SILI
能在隔离的 JavaScript 沙箱里执行一段代码做数学/数据处理类工作，但不
能影响宿主进程或容器。

实现路线选定 **本地 QuickJS（WASM）+ 入口契约 `function main()`**：
不联网、不读盘、不可调用宿主 API；**不预置任何第三方库**，AI 直接用
原生 ECMAScript（QuickJS 当前支持到 ES2023）即可——简单计算原生 JS 已
足够，复杂算法由 AI 自己实现（这正是 LLM 的强项）。

## Non-Goals

- 不接入云沙箱（Vercel Sandbox / E2B 等）；本期仅做本地 QuickJS 后端。
  若未来证实需要 Python/shell 能力，再走单独的 spec 引入云后端，并以
  本期沙箱接口的并列实现存在，不复用本期 runtime 抽象。
- 不开放任何形式的网络访问（fetch / XHR / WebSocket 全部不可用）。
- 不暴露为 Koishi 用户可见命令；仅作为 LLM tool 注册。
- 不做跨 tool call 的状态保留（每次调用新建 VM，执行完销毁）。
- 不允许 `require` / `import` / 加载第三方代码。
- 不预置任何第三方库（mathjs / dayjs / lodash 等）。沙箱内只有 QuickJS
  原生的 ECMAScript 标准库 + 我们注入的 `console`。

## 整体架构

```
LLM ──tool call──▶ tools/code-sandbox.ts (定义 + handler 薄包装)
                          │
                          ▼
                   services/code-sandbox-runtime.ts
                          │
                          ▼
                   quickjs-emscripten (WASM)
                          │
                          ▼
                   注入: console.{log,warn,error}
```

### 为什么选 QuickJS 而不是 isolated-vm

- `isolated-vm` 是 native addon。SILI 容器是 `linux/amd64` + bun，
  prebuilt 二进制与 bun runtime 的兼容性长期不可靠。
- `quickjs-emscripten` 是 WASM，无原生依赖，任何 arch / runtime 一
  致。启动 ~50-200ms 对单次 tool call 可接受。
- 隔离强度足够：QuickJS host 默认不提供 `fetch` / `process` / `fs` /
  `timer`，无需主动剥离。

## Tool 定义

工具名：`run_code_sandbox`

```ts
{
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
        description: '完整 JS 源码，必须包含 `function main() {}` 入口（sync / async 均可）',
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
```

## Runtime 行为

### 生命周期

每次 tool call：

1. 创建一个新的 `QuickJSContext`
2. `setMemoryLimit(memoryLimitMb * 1024 * 1024)`（默认 32MB）— **但 default disabled**（见下方"已知问题"）
3. `setMaxStackSize(256 * 1024)` — **同上**
4. 注入 `console.{log,warn,error}` 到 globalThis
5. `evalCode(userCode)` —— 定义 main
6. 校验 `main` 是 function，否则报错返回
7. `callFunction(main)` → `resolvePromise` + `executePendingJobs` → 拿
   到最终值
8. `dump` 出 JS 值后做返回值序列化
9. `dispose` VM + 所有 handle（finally 块）

整个过程包在一个 wall-clock timer 里：超时则 `interruptHandler` 返回
true，让 QuickJS 抛 InternalError。

### 注入清单

- `console.log` / `console.warn` / `console.error`：通过 `vm.newFunction`
  注册的 host 函数；参数按 `console` 语义拼接（多参数空格分隔，对象走
  `JSON.stringify` 兜底），收集到 stdout buffer。每条记录前缀
  `[log] ` / `[warn] ` / `[error] `。

仅此一项。无第三方库注入。

### 返回值序列化

| `main()` 返回类型 | 渲染 |
|---|---|
| `undefined` | 不显示 return value 段，只展示 stdout |
| `null` / `boolean` / `number` / `bigint` | `String(value)` |
| `string` | 原样输出（不加引号） |
| `object` / `array` | `JSON.stringify(value, null, 2)`，超 4KB 截断并附 `... (truncated, NKB total)` |
| 含循环引用 / 不可 JSON 序列化 | fallback `String(value)`，附 `(note: value contains non-JSON parts)` |
| `Error` 实例 | `Error: <msg>` |

### 错误归类

| 场景 | 返回 |
|---|---|
| code 解析失败 | `Error: SyntaxError: <msg> (line N)` |
| 没定义 main / main 不是 function | `Error: sandbox requires a top-level "function main()" entry (sync or async)` |
| 超时 | `Error: execution timed out after Nms` |
| 内存超限 | `Error: memory limit exceeded` |
| 运行时异常 | `Error: <Constructor>: <msg>\n<stack 前 5 行>` |

### Stdout 累积

- buffer 上限 `stdoutByteLimit`（默认 10240 字节）
- 超限后丢弃新内容，附 `... (stdout truncated at N bytes)`
- 即便 main 抛错，已积累的 stdout 也要附在错误信息后展示

## 配置面

新增 `Config.codeSandbox`：

```ts
codeSandbox?: {
  enabled?: boolean         // 默认 true
  memoryLimitMb?: number    // 默认 32
  maxTimeoutMs?: number     // 默认 10000，timeout_ms 入参的硬上限
  defaultTimeoutMs?: number // 默认 3000
  stdoutByteLimit?: number  // 默认 10240
}
```

注册逻辑（与 tavily 类似但默认开启）：

```ts
const sb = config.codeSandbox ?? {}
if (sb.enabled !== false) {
  this.tools.register(buildCodeSandboxHandler(this.logger, sb))
}
```

## 文件改动

- 新增 `src/plugins/llm/services/code-sandbox-runtime.ts`
  - `class CodeSandboxRuntime`：构造时拿配置 + logger；`run(code, opts)`
    返回 `{ stdout, returnValue, errorMessage, durationMs }`
  - 单一职责：VM 生命周期、console 注入、序列化、超时
- 新增 `src/plugins/llm/tools/code-sandbox.ts`
  - 导出 `CODE_SANDBOX_TOOL: ToolDefinition`
  - 导出 `buildCodeSandboxHandler(logger, config): ToolHandler`
  - 薄包装：拿 args、clamp timeout_ms、调 runtime、拼 markdown 输出
- 改 `src/plugins/llm/tools/index.ts`：加 `export * from './code-sandbox'`
- 改 `src/plugins/llm/index.tsx`：
  - 在 `Config` 接口里加 `codeSandbox` 字段
  - 在 ToolRegistry 注册段加 code-sandbox 注册
- 新增 `src/plugins/llm/__tests__/code-sandbox.test.ts`
- `package.json`：加 `quickjs-emscripten`（仅此一项）

## 测试覆盖

vitest 用例（每条对应 1-2 个 it block）：

- **基础同步**：`function main(){ return 1+1 }` → "2"
- **async**：`async function main(){ return await Promise.resolve(42) }` → "42"
- **原生数学**：`function main(){ return Math.sqrt(2) + 1 }`
- **原生日期**：`function main(){ return new Date('2024-01-01').toISOString() }`
- **BigInt**：`function main(){ return 2n ** 64n }` → "18446744073709551616"
- **对象返回**：`function main(){ return {a:1,b:[2,3]} }` → 格式化 JSON
- **string 返回**：返回字符串不加引号
- **undefined 返回**：只显示 stdout
- **console**：多次 log/warn/error 累积，前缀正确
- **超时**：`while(true){}` → 超时报错
- **内存**：大数组分配 → memory limit 报错
- **隔离**：`fetch('...')` / `process.exit()` / `require('fs')` / `setTimeout(()=>{})` → ReferenceError
- **入口缺失**：没定义 main → 友好报错
- **入口类型错**：`const main = 1` → 友好报错
- **SyntaxError**：`function main() { return 1+ }` → 报行号
- **stdout 截断**：循环 log 大字符串 → 截断 + 提示

## 风险与缓解

1. **冷启动延迟**：首次 tool call 加载 WASM ~100-200ms。可在 plugin
   `ready` hook 里预热（创建并销毁一次 VM），把这次延迟从用户感知路径
   移走。Plan 阶段决定是否预热。
2. **Promise resolution 死锁**：若 main 返回的 Promise 永不 resolve，
   `executePendingJobs` 也无法推进。靠 wall-clock timeout +
   `setInterruptHandler` 兜底。
3. **资源不可见泄漏**：必须保证 `dispose` 在 finally 里调用，无论
   eval/call 是否抛错，避免 WASM heap 泄漏。
4. **AI 不知道边界**：AI 可能尝试 `require('mathjs')` 或 `import dayjs`。
   tool description 已明确"无第三方库"，但需要观察实际表现；若高频
   误调，在 SILI-v5.prompt.md 加一行强化提醒。

## 已知问题：getQuickJS() singleton 在长跑 Node 进程里炸 WASM

落地后在 SILI 生产环境（linux/amd64 + tsx + cordis 多 plugin 长跑进程）
发现：调 `runtime.setMemoryLimit` 和 `runtime.setMaxStackSize` 后，**即便
最简单的 `function main() { return 1+1 }` 也会在 WASM 内部 trap**：

```
RuntimeError: memory access out of bounds
    at wasm-function[105], [136], [674], [1141]
    at va (emscripten-module.mjs)
```

后续 `vm.dispose` 又会触发 QuickJS C 层断言失败：
`Aborted(Assertion failed: ctx->header.ref_count == 0)`。

**复现条件极挑剔**：
- ✅ macOS arm64：本地全部跑通（包括 5M 蒙特卡洛）
- ✅ 同一 linux/amd64 容器里的 fresh tsx process：跑通
- ✅ 同容器内 `node --no-opt -r /proc/.reset` 完全复现 bun 启动参数：跑通
- ❌ 同容器内 cordis 长跑 bot process：trap

第一次绕路是 `disableHostLimits` 默认 `true`，跳过 setMemoryLimit。
但这制造了一个**真正的 DoS 漏洞**——沙箱化的 user code 可以 `'A'.repeat(1e9)`
一句话吃掉 1GB host 内存（user 验证：成功分配 1GB 字符串 + 百万对象 +
2亿数组元素，没任何拦截）。

**最终解决方案**：把 `getQuickJS()` singleton 换成 `newQuickJSWASMModule()`
**每次调用都新建**一个独立的 WASM 模块。fresh process 探针证明独立模块
不受 singleton 状态污染影响——setMemoryLimit 重新可用。开销：每次调用
约 50-100ms WASM 实例化（对交互式 bot 工具可接受）。

带来的好处：
- `disableHostLimits` 默认翻回 `false`（DoS 防护回来）
- `setMemoryLimit` 在每个 fresh 模块上正常工作，单 opcode 巨型分配
  （`'A'.repeat(1e9)`）会被立刻拦下，返回 `Error: memory limit exceeded`
- M7 测试不需要改

**Watchdog 是 best-effort，不是兜底**：runtime 里仍然有 `rssGrowthCapMb`
host 端 RSS 监控，但实测 QuickJS interrupt handler 触发频率很低（~50ms
一次），快循环根本来不及检查；async pump loop 的 5ms cadence 也对 `await
Promise.resolve()` 这种立刻 microtask flush 的链无能为力。Watchdog 留作
极少数慢路径的 safety net，**DoS 防护的实际依赖是 `setMemoryLimit`**。

`disableHostLimits` 仍保留为 escape hatch，但 jsdoc 明确警告默认值
（false）不应该改，除非用户明确知道自己在做什么且接受 DoS 风险。
