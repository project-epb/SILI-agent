# LLM catalog agent/人类双视图分离 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 koishi command 加 `descriptionForAgents` / `helpForAgents` / `hideForHuman` / `hideForAgents` 四个 config 字段，让 LLM command catalog 与人类 `help` 成为可独立控制的两个视图。

**Architecture:** 复用官方 `Command.Config`（`declare module` 扩展四字段）。agent 侧由我们全控的 `buildCommandCatalog` 读新字段决定可见性与描述；人类侧靠把 `hideForHuman` 投影到官方 `config.hidden`（plugin-help 只认它）。两侧解耦，缺省时逐字节回归现状。

**Tech Stack:** TypeScript, koishi `^4.18.9`, `@koishijs/plugin-help`, vitest。

## Global Constraints

- 新增四字段全部可选；都不设时 catalog 输出（概览 + 详情）与改动前**逐字节不变**（回归硬条件）。
- `descriptionForAgents` 必须是 deterministic 静态串（不含时间戳/随机数）——它进 system prompt，按 `(basePrompt, catalog, extensions)` memoize，非确定值会令 prompt cache 永久 miss。
- 路径别名：`@/*`→`src/*`，`~/*`→`src/plugins/*`。被改文件都在 `src/plugins/llm/` 下。
- 测试命令：`npx vitest run src/plugins/llm/__tests__/command-catalog.test.ts`。
- 当前分支：`feat/comfyui`，每个 task 一个 commit。

## File Structure

- `src/plugins/llm/utils/command-catalog.ts`（**改**）：`declare module 'koishi'` 扩展 `Command.Config`；`buildCommandCatalog` 的 description 取值与可见性过滤；`CommandCatalogEntry` 增 `agentHelp`；`renderCatalogEntryDetail` 用 `agentHelp`；导出纯函数 `projectHideForHuman`。
- `src/plugins/llm/services/command-catalog.ts`（**改**）：`bind()` 里对现有命令 + `command-added` 增量做 `hideForHuman` 投影。
- `src/plugins/llm/__tests__/command-catalog.test.ts`（**改**）：新增 `buildCommandCatalog`（fake-ctx）、`renderCatalogEntryDetail`(agentHelp)、`projectHideForHuman` 用例。

测试基础设施（fake ctx / fake cmd）首次在 Task 1 引入，后续任务复用。

---

### Task 1: 类型扩展 + `descriptionForAgents` + 测试基础设施

**Files:**
- Modify: `src/plugins/llm/utils/command-catalog.ts`（顶部加 `declare module`；`buildCommandCatalog` description 取值链）
- Test: `src/plugins/llm/__tests__/command-catalog.test.ts`（新增 fake-ctx helper + buildCommandCatalog 描述用例）

**Interfaces:**
- Produces: `Command.Config` 扩展字段 `descriptionForAgents` / `helpForAgents` / `hideForHuman` / `hideForAgents`（本 task 声明全部四个，后续 task 消费）。`buildCommandCatalog(ctx)` 行为：description 优先取 `config.descriptionForAgents`。
- Produces（测试侧）：`makeCmd(over)` / `makeCtx(commands)` fake 工厂，供 Task 2/3 复用。

- [ ] **Step 1: 写失败测试**

在 `command-catalog.test.ts` 顶部 import 处加入 `buildCommandCatalog`，文件末尾追加：

```ts
// ---- fake koishi ctx/command factories for buildCommandCatalog ----
function makeCmd(over: any = {}): any {
  return {
    name: over.name ?? 'cmd',
    displayName: over.displayName,
    config: over.config ?? {},
    locale: '',
    _description: over._description ?? '',
    _usage: over._usage,
    _arguments: over._arguments ?? [],
    _options: over._options ?? {},
    _aliases: over._aliases ?? {},
    children: over.children ?? [],
    parent: over.parent ?? null,
    _root: undefined,
  }
}
function makeCtx(commands: any[]): any {
  return {
    $commander: { _commandList: commands },
    i18n: { text: () => '' },
  }
}

describe('buildCommandCatalog: descriptionForAgents', () => {
  it('uses descriptionForAgents over the human description', () => {
    const cmd = makeCmd({
      name: 'comfyui.generate',
      _description: '人类看的描述',
      config: { descriptionForAgents: '当需要画图时调用' },
    })
    const entries = buildCommandCatalog(makeCtx([cmd]))
    expect(entries[0].description).toBe('当需要画图时调用')
  })

  it('falls back to the human description when descriptionForAgents is absent', () => {
    const cmd = makeCmd({ name: 'foo', _description: '普通描述' })
    const entries = buildCommandCatalog(makeCtx([cmd]))
    expect(entries[0].description).toBe('普通描述')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/plugins/llm/__tests__/command-catalog.test.ts -t "descriptionForAgents"`
Expected: 第一个用例 FAIL（实际取到 `'人类看的描述'`，期望 `'当需要画图时调用'`）；第二个 PASS。

- [ ] **Step 3: 实现**

在 `command-catalog.ts` 顶部 `import { Context } from 'koishi'` 之后加类型扩展：

```ts
declare module 'koishi' {
  namespace Command {
    interface Config {
      /** agent catalog 专用描述；存在则覆盖 description（仅对 agent 生效，不影响人类 help）。必须是确定性静态串。 */
      descriptionForAgents?: string
      /** agent 调 help 时详情段专用文案（更技术性）；缺省回落 description/usage。 */
      helpForAgents?: string
      /** 仅对人类 help 隐藏，agent catalog 仍可见（投影到 config.hidden 落地）。 */
      hideForHuman?: boolean
      /** 仅对 agent catalog 隐藏，人类 help 正常可见。 */
      hideForAgents?: boolean
    }
  }
}
```

在 `buildCommandCatalog` 内，将 description 取值链（现约 207–211 行）改为头部插入 `descriptionForAgents`：

```ts
const description: string =
  cmd.config?.descriptionForAgents ||
  i18n(`commands.${cmd.name}.description`) ||
  cmd._description ||
  cmd.config?.description ||
  ''
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/plugins/llm/__tests__/command-catalog.test.ts -t "descriptionForAgents"`
Expected: PASS（2 passed）。

- [ ] **Step 5: 提交**

```bash
git add src/plugins/llm/utils/command-catalog.ts src/plugins/llm/__tests__/command-catalog.test.ts
git commit -m "feat(llm): descriptionForAgents overrides catalog description for agents"
```

---

### Task 2: agent 侧可见性三态过滤

**Files:**
- Modify: `src/plugins/llm/utils/command-catalog.ts`（`buildCommandCatalog` 的 `visit` 过滤逻辑）
- Test: `src/plugins/llm/__tests__/command-catalog.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `makeCmd` / `makeCtx`、`Command.Config` 字段。
- Produces: `buildCommandCatalog` 过滤规则 —— `hideForAgents` 排除；`hidden && !hideForHuman` 排除。

- [ ] **Step 1: 写失败测试**

追加到 `command-catalog.test.ts`：

```ts
describe('buildCommandCatalog: agent-side visibility', () => {
  it('hideForAgents excludes the command from the catalog', () => {
    const cmds = [
      makeCmd({ name: 'a' }),
      makeCmd({ name: 'b', config: { hideForAgents: true } }),
    ]
    const entries = buildCommandCatalog(makeCtx(cmds))
    expect(entries.map((e) => e.name)).toEqual(['a'])
  })

  it('hideForHuman keeps the command visible to agents', () => {
    const cmds = [makeCmd({ name: 'a', config: { hideForHuman: true } })]
    const entries = buildCommandCatalog(makeCtx(cmds))
    expect(entries.map((e) => e.name)).toEqual(['a'])
  })

  it('plain hidden is excluded from the catalog (regression)', () => {
    const cmds = [makeCmd({ name: 'a', config: { hidden: true } })]
    const entries = buildCommandCatalog(makeCtx(cmds))
    expect(entries).toHaveLength(0)
  })

  it('hidden + hideForHuman stays visible to agents (projected case)', () => {
    const cmds = [
      makeCmd({ name: 'a', config: { hidden: true, hideForHuman: true } }),
    ]
    const entries = buildCommandCatalog(makeCtx(cmds))
    expect(entries.map((e) => e.name)).toEqual(['a'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/plugins/llm/__tests__/command-catalog.test.ts -t "agent-side visibility"`
Expected: `hideForAgents` 用例 FAIL（现状不识别 hideForAgents → 返回 `['a','b']`）；`hidden + hideForHuman` 用例 FAIL（现状被 `if (hidden)` 排除 → 返回 `[]`）；另外两个 PASS。

- [ ] **Step 3: 实现**

在 `buildCommandCatalog` 的 `visit` 里，把现有的单行 `if (cmd.config?.hidden) return null`（约 197 行）替换为：

```ts
if (cmd.config?.hideForAgents) return null
if (cmd.config?.hidden && !cmd.config?.hideForHuman) return null
```

保留其后的 `if (isForbiddenAgentCommand(cmd.name)) return null` 不动。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/plugins/llm/__tests__/command-catalog.test.ts -t "agent-side visibility"`
Expected: PASS（4 passed）。

- [ ] **Step 5: 提交**

```bash
git add src/plugins/llm/utils/command-catalog.ts src/plugins/llm/__tests__/command-catalog.test.ts
git commit -m "feat(llm): split agent/human command visibility (hideForAgents/hideForHuman)"
```

---

### Task 3: `helpForAgents` → `agentHelp` 详情

**Files:**
- Modify: `src/plugins/llm/utils/command-catalog.ts`（`CommandCatalogEntry` 增字段、`buildCommandCatalog` 填充、`renderCatalogEntryDetail` 取值）
- Test: `src/plugins/llm/__tests__/command-catalog.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `helpForAgents` config 字段。
- Produces: `CommandCatalogEntry.agentHelp?: string`；`renderCatalogEntryDetail` 描述段优先用 `agentHelp`。

- [ ] **Step 1: 写失败测试**

追加到 `command-catalog.test.ts`（`renderCatalogEntryDetail` describe 块附近或文件末尾新 describe）：

```ts
describe('renderCatalogEntryDetail: agentHelp', () => {
  it('uses agentHelp for the description section when present', () => {
    const entry: CommandCatalogEntry = {
      name: 'comfyui.generate',
      description: '简短描述',
      agentHelp: '详细技术帮助：template 必填，prompt 必填，loras 传 JSON',
      args: [],
      options: [],
      aliases: [],
      children: [],
    }
    const out = renderCatalogEntryDetail(entry)
    expect(out).toContain('详细技术帮助')
    expect(out).not.toContain('简短描述')
  })

  it('falls back to description when agentHelp is absent', () => {
    const entry: CommandCatalogEntry = {
      name: 'foo',
      description: '普通描述',
      args: [],
      options: [],
      aliases: [],
      children: [],
    }
    const out = renderCatalogEntryDetail(entry)
    expect(out).toContain('普通描述')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/plugins/llm/__tests__/command-catalog.test.ts -t "agentHelp"`
Expected: 第一个用例 FAIL（详情段仍渲染 `'简短描述'` → `not.toContain('简短描述')` 失败）；第二个 PASS。
（若 TS 报 `agentHelp` 不在类型上，属预期——下一步加字段；vitest 经 esbuild 不阻断运行。）

- [ ] **Step 3: 实现**

在 `CommandCatalogEntry` interface 增可选字段（紧挨 `usage?` 之后）：

```ts
  /** agent-only 详情文案（来自 command config 的 helpForAgents）；优先于 description 渲染。 */
  agentHelp?: string
```

在 `buildCommandCatalog` 的 `visit` return 的对象里增一行（与 `usage` 同级）：

```ts
      agentHelp: cmd.config?.helpForAgents,
```

在 `renderCatalogEntryDetail` 中，把描述段那行（现 `lines.push(entry.description?.trim() || '(无描述)')`）改为：

```ts
  lines.push(entry.agentHelp?.trim() || entry.description?.trim() || '(无描述)')
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/plugins/llm/__tests__/command-catalog.test.ts -t "agentHelp"`
Expected: PASS（2 passed）。

- [ ] **Step 5: 提交**

```bash
git add src/plugins/llm/utils/command-catalog.ts src/plugins/llm/__tests__/command-catalog.test.ts
git commit -m "feat(llm): helpForAgents provides agent-specific command help detail"
```

---

### Task 4: `hideForHuman` → `hidden` 投影（纯函数 + service hook）

**Files:**
- Modify: `src/plugins/llm/utils/command-catalog.ts`（导出 `projectHideForHuman`）
- Modify: `src/plugins/llm/services/command-catalog.ts`（`bind()` 内 wiring）
- Test: `src/plugins/llm/__tests__/command-catalog.test.ts`

**Interfaces:**
- Produces: `projectHideForHuman(config: any): void` —— 若 `config.hideForHuman` 为真且 `config.hidden === undefined`，设 `config.hidden = true`。
- Consumes: `CommandCatalogService.bind()` 调它（现有命令遍历 + `command-added` 增量）。

- [ ] **Step 1: 写失败测试**

在 `command-catalog.test.ts` import 处加 `projectHideForHuman`，追加：

```ts
describe('projectHideForHuman', () => {
  it('sets hidden=true for a hideForHuman command', () => {
    const config: any = { hideForHuman: true }
    projectHideForHuman(config)
    expect(config.hidden).toBe(true)
  })

  it('does not override an explicitly-set hidden', () => {
    const config: any = { hideForHuman: true, hidden: false }
    projectHideForHuman(config)
    expect(config.hidden).toBe(false)
  })

  it('is a no-op when hideForHuman is absent', () => {
    const config: any = {}
    projectHideForHuman(config)
    expect(config.hidden).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/plugins/llm/__tests__/command-catalog.test.ts -t "projectHideForHuman"`
Expected: FAIL（`projectHideForHuman is not a function` / import 未定义）。

- [ ] **Step 3: 实现纯函数**

在 `command-catalog.ts` 导出：

```ts
/**
 * 把 `hideForHuman` 投影到官方 `config.hidden`，让 @koishijs/plugin-help
 * 对人类隐藏该命令（plugin-help 只读 config.hidden）。仅在未显式设置
 * hidden 时投影，避免覆盖使用方意图。agent 侧 buildCommandCatalog 用
 * `!hideForHuman` 豁免，故投影后 agent 仍可见。
 */
export function projectHideForHuman(config: any): void {
  if (config?.hideForHuman && config.hidden === undefined) {
    config.hidden = true
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/plugins/llm/__tests__/command-catalog.test.ts -t "projectHideForHuman"`
Expected: PASS（3 passed）。

- [ ] **Step 5: wiring 到 service**

在 `services/command-catalog.ts` 的 import 加 `projectHideForHuman`：

```ts
import {
  type CommandCatalogEntry,
  buildCommandCatalog,
  projectHideForHuman,
  renderCompactCatalog,
} from '../utils/command-catalog'
```

把 `bind()` 改为：

```ts
  bind(): void {
    // hideForHuman → config.hidden 投影：对已注册命令补一遍，并监听后续新增命令。
    for (const cmd of (this.ctx as any).$commander?._commandList ?? []) {
      projectHideForHuman(cmd.config)
    }
    this.ctx.on('command-added', (cmd: any) => projectHideForHuman(cmd.config))
    this.ctx.on('ready', () => this.refresh('ready'))
  }
```

- [ ] **Step 6: 跑全量 catalog 测试 + 类型检查**

Run: `npx vitest run src/plugins/llm/__tests__/command-catalog.test.ts`
Expected: 全部 PASS（原有用例 + 新增用例）。

Run: `npx tsc --noEmit -p . 2>&1 | grep "command-catalog" || echo "no new errors"`
Expected: 无 `command-catalog` 相关新错误（仓库已知 `chat.tsx:67 minInterval` 噪音与本改动无关）。

- [ ] **Step 7: 提交**

```bash
git add src/plugins/llm/utils/command-catalog.ts src/plugins/llm/services/command-catalog.ts src/plugins/llm/__tests__/command-catalog.test.ts
git commit -m "feat(llm): project hideForHuman onto config.hidden for plugin-help"
```

---

## 集成验证（实施全部 task 后，一次性）

纯函数测试覆盖不到 service hook 的真实 wiring 与 plugin-help 行为，启动一次容器验证：

1. 临时在某个插件注册一条 `ctx.command('__probe', '探针', { hideForHuman: true, descriptionForAgents: '仅 agent 可见的探针' })`（验证后删除）。
2. `docker compose restart core`，约 10s 后：
   - 人类 `;help` 不列出 `__probe`（`hideForHuman` 经投影生效）。
   - 看启动日志 `command catalog rebuilt`，`;llm.catalog` 后 agent catalog 概览含 `__probe` 且描述为「仅 agent 可见的探针」。
3. 删除探针命令，重启复原。

（此验证步骤不写进测试套件，仅手动跑一次确认 wiring；ComfyUI 插件 plan B 的真实命令会再覆盖一次。）

## Self-Review

- **Spec coverage**：descriptionForAgents(T1)、agent 三态过滤(T2)、helpForAgents(T3)、hideForHuman 投影(T4)、类型扩展(T1)、回归 plain-hidden(T2)。spec「实现落点」1–3 + 视图矩阵全覆盖。落点 4（cache 约束）是文档约束无需 task。✓
- **Placeholder scan**：无 TBD/TODO，每步含完整代码。✓
- **Type consistency**：`descriptionForAgents`/`helpForAgents`/`hideForHuman`/`hideForAgents`（config）、`agentHelp`（entry）、`projectHideForHuman`（函数）全程一致。✓
