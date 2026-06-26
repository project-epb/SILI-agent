# ComfyUI 插件 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Hermes 的 Python `comfyui` 插件移植到 SILI（koishi/TS），新增独立插件 `src/plugins/comfy-ui/`，提供 `comfyui.templates` / `comfyui.guide` / `comfyui.generate` 三个命令（注册为纯 agent 工具），支持 aspect_ratio 预设、LoRA 池叠加、model guide。

**Architecture:** 配置注入式——插件核心只吃标准对象（`workflows: TemplateBindings[]` / `guides: Guide[]`），目录扫描封装成导出的静态方法 `scanWorkflowTemplates` / `scanGuides`。认证复用 koishi `HTTP.Config`，client 用 `ctx.http.extend(config.http)`。命令以 `hideForHuman: true` + `descriptionForAgents` 注册（依赖已落地的 catalog 双视图，见 `2026-06-23-llm-catalog-agent-views.md`）。出图走 `session.send(h.image(dataUri))`，ref 化由 llm 侧 `execute-koishi-command` 自动兜底（本插件不碰 `ctx.llm`）。

**Tech Stack:** TypeScript, koishi `^4.18.9`, `@cordisjs/plugin-http`（`ctx.http`）, `@satorijs/element`（`h.image`）, vitest。

**移植规格说明：** 这是移植任务，算法的**完整规格 = Hermes 源码**。每个 task 指明移植自 Hermes 的哪个文件/函数（路径 `~/.hermes/plugins/comfyui/`），并给出确切的 TS 接口签名与关键测试。实施者**必须读对应的 Hermes 源文件**作为算法依据，保持逻辑等价，用 TS 惯例改写（Python dict→object、list→array、深拷贝用 `structuredClone`、`copy.deepcopy`→`structuredClone`、异常→自定义 Error 类）。Hermes 测试（`~/.hermes/plugins/comfyui/tests/`）是测试用例的来源，移植成 vitest。

## Global Constraints

- 插件目录 `src/plugins/comfy-ui/`，类继承 `~/_boilerplate`（`BasePlugin`），与 SILI 其它插件一致。
- 路径别名：`@/*`→`src/*`，`~/*`→`src/plugins/*`，`$utils/*`→`src/utils/*`。
- **不 inject llm，不碰 `ctx.llm`**；`inject` 含 `http`（`static inject = { http: { required: true } }`）。
- 命令注册为纯 agent 工具：`{ hideForHuman: true, descriptionForAgents: '<skill风格>' }`，参数细节进 option 描述 + `helpForAgents`。
- 认证统一进 `http: HTTP.Config`（`baseURL`/`headers`/`timeout`）；client 默认补 `User-Agent: sili-comfyui/0.1`（可被 headers 覆盖）。**不做** `auth:{type}` 判别联合。
- `defaultGenerateTimeoutS` 默认 600，上限 600；尺寸校验范围 [64,4096] 且为 8 的倍数。
- 测试命令：`npx vitest run src/plugins/comfy-ui/__tests__`；类型检查 `npx tsc --noEmit -p .`。
- 当前分支 `feat/comfyui`，每个 task 一个 commit。本版**不做**多后端路由、websocket、落盘缓存、img2img/ControlNet。

## File Structure

```
src/plugins/comfy-ui/
├── index.tsx           插件入口：BasePlugin 子类 + Config + static scanWorkflowTemplates/scanGuides/basicAuth + 三命令注册
├── client.ts           ComfyUIClient：ctx.http.extend、submit/pollUntilDone/fetchImage、错误分类 + ComfyError 类型
├── template-loader.ts  类型(TemplateBindings/AvailableLora/Guide) + ASPECT_RATIO_MAP + 节点识别 + LoRA 池/trace + applyOverrides + scanWorkflowTemplates/scanGuides + loadTemplate
├── lora-validate.ts    validateLorasArg（命令层 LoRA 入参校验，纯函数，便于测试）
└── __tests__/
    ├── fixtures.ts            内联 workflow JSON 构造器（不依赖外部文件）
    ├── template-loader.test.ts
    ├── lora.test.ts
    ├── apply-overrides.test.ts
    ├── client.test.ts
    └── lora-validate.test.ts
```

注：`template-loader.ts` 较大但内聚（都是模板解析），与 Hermes 的单文件 `template_loader.py` 对应，保持一致不强拆。

## 测试夹具（Task 1 建立，后续复用）

`__tests__/fixtures.ts` 提供内联 workflow 构造器，替代 Hermes 依赖的外部 `anima_boilerplate.json`：

```ts
// 一个最小但完整的 txt2img workflow（API-format），覆盖 topology trace。
export function minimalWorkflow(): Record<string, any> {
  return {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'anima.safetensors' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, 1girl', clip: ['4', 1] }, _meta: { title: 'Positive Prompt' } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: 'low quality, worst quality, bad anatomy', clip: ['4', 1] }, _meta: { title: 'Negative Prompt' } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 } },
    '3': { class_type: 'KSampler', inputs: { seed: 123, steps: 28, cfg: 5, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0] } },
  }
}

// 带一个悬空 LoraLoader（model/clip 端口不接线）的 workflow，用于 LoRA 池测试。
export function workflowWithDanglingLora(): Record<string, any> {
  const wf = minimalWorkflow()
  wf['20'] = { class_type: 'LoraLoader', inputs: { lora_name: 'detail.safetensors', strength_model: 0.8, strength_clip: 0.8 } }
  return wf
}
```

实施者按各 task 需要扩展 fixtures（如 dualclip、locked LoRA），命名清晰即可。

---

### Task 1: 脚手架 + 类型 + 常量 + helper

**Files:**
- Create: `src/plugins/comfy-ui/template-loader.ts`（类型 + `ASPECT_RATIO_MAP`）
- Create: `src/plugins/comfy-ui/index.tsx`（`PluginComfyUI` 骨架：继承 BasePlugin，`static inject`，空 Config，`static basicAuth`，构造函数暂只存配置 + 日志一行；命令注册留到 Task 7）
- Create: `src/plugins/comfy-ui/__tests__/fixtures.ts`（上方两个构造器）
- Create: `src/plugins/comfy-ui/__tests__/helpers.test.ts`

**Interfaces (Produces):**
```ts
// template-loader.ts
export interface AvailableLora { name: string; nodeId: string; strengthModel: number; strengthClip: number }
export interface TemplateBindings {
  name: string
  server?: string                 // 预留，本版恒 undefined（不做多后端）
  positiveNode: string
  negativeNode: string | null
  samplerNode: string | null
  latentNode: string | null
  seedPrompt: string
  seedNegative: string
  defaults: Record<string, any>   // steps/cfg/sampler_name/scheduler/width/height...
  modelSummary: string
  raw: Record<string, any>
  availableLoras: AvailableLora[]
  modelSource: [string, number] | null
  clipSource: [string, number] | null
  loraLocked: boolean
  loraLockReason: string | null
}
export interface Guide { name: string; content: string }
export const ASPECT_RATIO_MAP: Record<string, [number, number]>  // 9 键，见下

// index.tsx
export default class PluginComfyUI extends BasePlugin<Config> {
  static basicAuth(username: string, password: string): { Authorization: string }
}
```

`ASPECT_RATIO_MAP`（移植 Hermes `template_loader.py` 的 `ASPECT_RATIO_MAP`，键值完全一致）：
`portrait:[832,1216]`, `landscape:[1216,832]`, `square:[1024,1024]`, `large_portrait:[1024,1536]`, `large_landscape:[1536,1024]`, `large_square:[1472,1472]`, `small_portrait:[512,768]`, `small_landscape:[768,512]`, `small_square:[640,640]`。

- [ ] **Step 1: 写失败测试** `__tests__/helpers.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { ASPECT_RATIO_MAP } from '../template-loader'
import PluginComfyUI from '../index'

describe('ASPECT_RATIO_MAP', () => {
  it('has the 9 NovelAI-style presets with exact dims', () => {
    expect(Object.keys(ASPECT_RATIO_MAP)).toHaveLength(9)
    expect(ASPECT_RATIO_MAP.portrait).toEqual([832, 1216])
    expect(ASPECT_RATIO_MAP.landscape).toEqual([1216, 832])
    expect(ASPECT_RATIO_MAP.square).toEqual([1024, 1024])
    expect(ASPECT_RATIO_MAP.large_square).toEqual([1472, 1472])
    expect(ASPECT_RATIO_MAP.small_landscape).toEqual([768, 512])
  })
})

describe('PluginComfyUI.basicAuth', () => {
  it('builds an HTTP Basic Authorization header', () => {
    const h = PluginComfyUI.basicAuth('user', 'pass')
    expect(h.Authorization).toBe('Basic ' + Buffer.from('user:pass').toString('base64'))
  })
})
```

- [ ] **Step 2: 跑确认失败** `npx vitest run src/plugins/comfy-ui/__tests__/helpers.test.ts` — Expected: FAIL（模块不存在）。
- [ ] **Step 3: 实现** 建 `template-loader.ts`（类型 + `ASPECT_RATIO_MAP`）、`index.tsx`（骨架 + `static basicAuth`）、`fixtures.ts`。`basicAuth` 实现：`return { Authorization: 'Basic ' + Buffer.from(\`${username}:${password}\`).toString('base64') }`。index.tsx 骨架：
```ts
import { Context, Schema } from 'koishi'
import BasePlugin from '~/_boilerplate'
import type { HTTP } from '@cordisjs/plugin-http'
import type { TemplateBindings, Guide } from './template-loader'

export interface Config {
  http?: HTTP.Config
  workflows?: TemplateBindings[]
  guides?: Guide[]
  defaultGenerateTimeoutS?: number
}

export default class PluginComfyUI extends BasePlugin<Config> {
  static inject = { http: { required: true } }
  constructor(ctx: Context, config: Config) {
    super(ctx, config, 'comfyui')
    this.logger.info('comfyui: %d templates, %d guides',
      config.workflows?.length ?? 0, config.guides?.length ?? 0)
    // 命令注册在 Task 7 加入
  }
  static basicAuth(username: string, password: string) {
    return { Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64') }
  }
}
```
- [ ] **Step 4: 跑确认通过** 同 Step 2 命令 — Expected: PASS。
- [ ] **Step 5: 提交** `git add src/plugins/comfy-ui && git commit -m "feat(comfyui): scaffold plugin, types, aspect-ratio map, basicAuth helper"`

---

### Task 2: 模板节点识别（移植 `template_loader.py` 上半）

**Files:**
- Modify: `src/plugins/comfy-ui/template-loader.ts`（加节点识别函数）
- Create: `src/plugins/comfy-ui/__tests__/template-loader.test.ts`

**移植源：** `~/.hermes/plugins/comfyui/template_loader.py` 的 `load_raw` / `_sorted_node_ids` / `find_sampler_node` / `find_latent_node` / `_is_clip_text_encode` / `_node_title` / `_node_text` / `_try_topology_trace` / `_try_title_match` / `_try_negative_keyword_inference` / `find_prompt_nodes`。测试源：`tests/test_template_loader.py` 的 `find_*` 部分。

**Interfaces (Produces):**
```ts
export class TemplateLoadError extends Error {}
export class AmbiguousPromptError extends TemplateLoadError {}
export function loadRaw(text: string, name: string): Record<string, any>   // 解析 + 结构校验（顶层 object、每节点含 class_type），失败抛 TemplateLoadError
export function findSamplerNode(api: Record<string, any>): string | null   // 首个 class_type 以 'KSampler' 开头，按 id 数值序最小
export function findLatentNode(api: Record<string, any>): string | null    // EmptyLatentImage / EmptySD3LatentImage
export function findPromptNodes(api: Record<string, any>, samplerId: string | null): [string, string | null]  // [positiveId, negativeId|null]；四级启发式；失败抛 AmbiguousPromptError
```

**关键测试（template-loader.test.ts）：**
```ts
import { describe, it, expect } from 'vitest'
import { loadRaw, findSamplerNode, findLatentNode, findPromptNodes, TemplateLoadError, AmbiguousPromptError } from '../template-loader'
import { minimalWorkflow } from './fixtures'

describe('loadRaw', () => {
  it('parses a valid api-format workflow', () => {
    const api = loadRaw(JSON.stringify(minimalWorkflow()), 'w.json')
    expect(api['3'].class_type).toBe('KSampler')
  })
  it('rejects non-object top level', () => {
    expect(() => loadRaw('[1,2,3]', 'bad.json')).toThrow(TemplateLoadError)
  })
  it('rejects a node missing class_type', () => {
    expect(() => loadRaw(JSON.stringify({ '1': { inputs: {} } }), 'bad.json')).toThrow(TemplateLoadError)
  })
  it('rejects invalid json', () => {
    expect(() => loadRaw('{not json', 'bad.json')).toThrow(TemplateLoadError)
  })
})

describe('findSamplerNode / findLatentNode', () => {
  it('finds the KSampler and EmptyLatentImage', () => {
    const api = minimalWorkflow()
    expect(findSamplerNode(api)).toBe('3')
    expect(findLatentNode(api)).toBe('5')
  })
  it('returns null when sampler absent', () => {
    expect(findSamplerNode({ '1': { class_type: 'CheckpointLoaderSimple', inputs: {} } })).toBeNull()
  })
  it('picks lowest id when multiple samplers', () => {
    const api: any = { '9': { class_type: 'KSampler', inputs: {} }, '2': { class_type: 'KSamplerAdvanced', inputs: {} } }
    expect(findSamplerNode(api)).toBe('2')
  })
  it('handles EmptySD3LatentImage', () => {
    const api: any = { '1': { class_type: 'EmptySD3LatentImage', inputs: { width: 1024, height: 1024 } } }
    expect(findLatentNode(api)).toBe('1')
  })
})

describe('findPromptNodes', () => {
  it('traces positive/negative from KSampler topology', () => {
    const api = minimalWorkflow()
    expect(findPromptNodes(api, '3')).toEqual(['6', '7'])
  })
  it('falls back to _meta.title keywords when topology indirect', () => {
    // KSampler.positive 指向一个非 CLIPTextEncode（如 ConditioningCombine），靠 title 区分
    const api: any = {
      '3': { class_type: 'KSampler', inputs: { positive: ['10', 0], negative: ['11', 0] } },
      '10': { class_type: 'ConditioningConcat', inputs: {} },
      '11': { class_type: 'ConditioningConcat', inputs: {} },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a' }, _meta: { title: 'Positive Prompt' } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: 'b' }, _meta: { title: 'Negative Prompt' } },
    }
    expect(findPromptNodes(api, '3')).toEqual(['6', '7'])
  })
  it('infers via negative keywords when exactly two untitled CLIPTextEncode', () => {
    const api: any = {
      '3': { class_type: 'KSampler', inputs: { positive: ['10', 0], negative: ['10', 0] } },
      '10': { class_type: 'ConditioningConcat', inputs: {} },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, 1girl' } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: 'low quality, worst quality, bad anatomy' } },
    }
    expect(findPromptNodes(api, '3')).toEqual(['6', '7'])
  })
  it('throws AmbiguousPromptError when unresolvable', () => {
    const api: any = {
      '3': { class_type: 'KSampler', inputs: { positive: ['10', 0] } },
      '10': { class_type: 'ConditioningConcat', inputs: {} },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a' } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: 'b' } },
      '8': { class_type: 'CLIPTextEncode', inputs: { text: 'c' } },
    }
    expect(() => findPromptNodes(api, '3')).toThrow(AmbiguousPromptError)
  })
  it('throws when no sampler', () => {
    expect(() => findPromptNodes(minimalWorkflow(), null)).toThrow(AmbiguousPromptError)
  })
})
```

**实现要点：** 逐函数对照 Hermes 移植。`_sorted_node_ids` → 数值优先排序（`(0, int)` vs `(1, str)`）。负面关键词集 `_NEG_KEYWORDS`/`_POS_KEYWORDS`/`_NEG_TEXT_HINTS` 原样搬。topology trace 解析 link `[nodeId, slot]`（TS 里是 `[string|number, number]`，注意 Hermes 用 `str(link[0])`）。

- [ ] **Step 1: 写失败测试**（上方代码）
- [ ] **Step 2: 跑确认失败** `npx vitest run src/plugins/comfy-ui/__tests__/template-loader.test.ts` — FAIL（函数未定义）
- [ ] **Step 3: 实现** 移植上述函数到 `template-loader.ts`
- [ ] **Step 4: 跑确认通过** — PASS
- [ ] **Step 5: 提交** `git add ... && git commit -m "feat(comfyui): port workflow node detection (sampler/latent/prompt heuristics)"`

---

### Task 3: 默认值/模型摘要 + LoRA 池扫描 + source trace

**Files:**
- Modify: `src/plugins/comfy-ui/template-loader.ts`
- Create: `src/plugins/comfy-ui/__tests__/lora.test.ts`

**移植源：** `template_loader.py` 的 `extract_defaults` / `extract_model_summary` / `scan_lora_pool` / `_references_to` / `trace_model_source` / `trace_clip_source` / `_follow_through_loraloader`。测试源：`tests/test_lora_scanning.py` + `test_template_loader.py` 的 extract 部分。

**Interfaces (Produces):**
```ts
export function extractDefaults(api: Record<string, any>, samplerId: string | null, latentId: string | null): Record<string, any>
export function extractModelSummary(api: Record<string, any>): string
export function scanLoraPool(api: Record<string, any>): { pool: AvailableLora[]; locked: boolean; lockedIds: string[] }
export function traceModelSource(api: Record<string, any>, samplerId: string): [string, number] | null
export function traceClipSource(api: Record<string, any>, positiveId: string): [string, number] | null
```

**关键测试（lora.test.ts）：** 移植 `test_lora_scanning.py`。代表用例：
```ts
import { describe, it, expect } from 'vitest'
import { extractDefaults, extractModelSummary, scanLoraPool, traceModelSource, traceClipSource } from '../template-loader'
import { minimalWorkflow, workflowWithDanglingLora } from './fixtures'

describe('extractDefaults', () => {
  it('pulls widget scalars from sampler + latent', () => {
    const d = extractDefaults(minimalWorkflow(), '3', '5')
    expect(d).toMatchObject({ steps: 28, cfg: 5, sampler_name: 'euler', scheduler: 'normal', width: 832, height: 1216 })
  })
  it('skips linked (non-widget) inputs', () => {
    const api: any = { '3': { class_type: 'KSampler', inputs: { steps: ['9', 0], cfg: 5 } } }
    const d = extractDefaults(api, '3', null)
    expect(d.cfg).toBe(5)
    expect('steps' in d).toBe(false)
  })
})

describe('extractModelSummary', () => {
  it('joins loader filenames', () => {
    expect(extractModelSummary(minimalWorkflow())).toBe('anima.safetensors')
  })
})

describe('scanLoraPool', () => {
  it('returns empty pool when no LoraLoader', () => {
    expect(scanLoraPool(minimalWorkflow())).toEqual({ pool: [], locked: false, lockedIds: [] })
  })
  it('collects a dangling LoraLoader into the pool', () => {
    const r = scanLoraPool(workflowWithDanglingLora())
    expect(r.locked).toBe(false)
    expect(r.pool).toHaveLength(1)
    expect(r.pool[0]).toMatchObject({ name: 'detail.safetensors', nodeId: '20', strengthModel: 0.8, strengthClip: 0.8 })
  })
  it('marks template locked when a LoraLoader is wired into the main path', () => {
    // 构造：LoraLoader 被 KSampler.model 引用 → wired → locked
    const api: any = {
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'm.safetensors' } },
      '20': { class_type: 'LoraLoader', inputs: { lora_name: 'x.safetensors', strength_model: 1, strength_clip: 1, model: ['4', 0], clip: ['4', 1] } },
      '3': { class_type: 'KSampler', inputs: { model: ['20', 0] } },
    }
    const r = scanLoraPool(api)
    expect(r.locked).toBe(true)
    expect(r.lockedIds).toContain('20')
    expect(r.pool).toEqual([])
  })
  it('skips a node with non-numeric strength widget', () => {
    const api: any = { '20': { class_type: 'LoraLoader', inputs: { lora_name: 'x', strength_model: ['9', 0], strength_clip: 1 } } }
    expect(scanLoraPool(api).pool).toEqual([])
  })
})

describe('trace source', () => {
  it('traces model source through to checkpoint', () => {
    expect(traceModelSource(minimalWorkflow(), '3')).toEqual(['4', 0])
  })
  it('traces clip source from positive node', () => {
    expect(traceClipSource(minimalWorkflow(), '6')).toEqual(['4', 1])
  })
  it('returns null when link missing', () => {
    expect(traceModelSource({ '3': { class_type: 'KSampler', inputs: {} } } as any, '3')).toBeNull()
  })
})
```
实施者补充 dualclip / UNETLoader / bool-strength / self-reference 用例（对照 `test_lora_scanning.py`）。

**实现要点：** `_LOADER_KEY_BY_CLASS` map 原样搬。`_is_widget_value`：link 是 `[id, slot]` 二元数组，其余是 widget。`_follow_through_loraloader` 穿透 LoraLoader 跳点，带环检测。注意 Hermes 的 `scan_lora_pool` 跳过 `bool` 型 strength（TS 里 `typeof === 'boolean'` 单独判，因为 JS `typeof true === 'boolean'` 不是 number，但要显式排除以对齐语义）。

- [ ] **Step 1–5:** 写测试 → 跑失败（`npx vitest run src/plugins/comfy-ui/__tests__/lora.test.ts`）→ 移植实现 → 跑通过 → commit `feat(comfyui): port defaults/model-summary extraction + LoRA pool scan + source trace`

---

### Task 4: applyOverrides + LoRA 链重连

**Files:**
- Modify: `src/plugins/comfy-ui/template-loader.ts`
- Create: `src/plugins/comfy-ui/__tests__/apply-overrides.test.ts`

**移植源：** `template_loader.py` 的 `_set_widget_or_warn` / `apply_overrides` / `_apply_lora_chain`。测试源：`tests/test_lora_rewiring.py`。

**Interfaces (Produces):**
```ts
export interface OverrideArgs {
  prompt: string
  negative?: string | null
  aspectRatio?: string | null
  width?: number | null
  height?: number | null
  steps?: number | null
  cfg?: number | null
  seed: number                       // 必填，调用方负责随机化 null
  loras?: Array<{ name: string; strengthModel?: number; strengthClip?: number }> | null
}
export function applyOverrides(t: TemplateBindings, args: OverrideArgs): Record<string, any>
```

**关键测试（apply-overrides.test.ts）：** 移植 `test_lora_rewiring.py`。代表：
```ts
import { describe, it, expect } from 'vitest'
import { loadTemplateFromApi } from '../template-loader'  // 见下注
import { applyOverrides } from '../template-loader'
import { minimalWorkflow, workflowWithDanglingLora } from './fixtures'

// 注：Task 5 才有 loadTemplate；本 task 测试可用一个轻量构造器把 fixture 直接组装成
// TemplateBindings（实施者在测试文件里写一个 local helper 调用 Task 2/3 的函数拼装），
// 避免对 Task 5 的前向依赖。

describe('applyOverrides', () => {
  it('no loras → byte-equivalent except prompt/seed/size widgets', () => {
    // 不传 loras 时，除被显式覆盖的 widget 外，workflow 结构不变
  })
  it('replaces positive prompt (never appends)', () => { /* positiveNode.inputs.text === prompt */ })
  it('overrides negative only when explicitly given', () => { /* 不传 negative → negativeNode.text 不变 */ })
  it('width/height takes precedence over aspect_ratio', () => { /* 同时传 → 用 wh */ })
  it('aspect_ratio sets latent width/height', () => { /* portrait → 832x1216 */ })
  it('injects seed into sampler', () => {})
  it('single lora wires into main path and redirects references', () => {
    // 对照 test_apply_single_lora_wires_into_main_path：LoraLoader.model=checkpoint，
    // KSampler.model 重定向到 LoraLoader.0
  })
  it('two-lora chain links in order', () => {})
  it('strength overrides applied; strength 0 respected', () => {})
})
```
实施者把 `test_lora_rewiring.py` 的 7 个测试逐一移植（byte-equivalent / single / two-chain / strength override / reorder / dualclip / strength-zero）。

**实现要点：** `structuredClone(t.raw)` 替代 `copy.deepcopy`。`_set_widget_or_warn`：若当前是 link 则 warn 跳过。`_apply_lora_chain`：按 agent 给定顺序串联，重定向所有引用 `modelSource`/`clipSource` 的输入到链尾。link 比较注意 `[str(v[0]), int(v[1])]` 归一。

- [ ] **Step 1–5:** 写测试 → 跑失败 → 移植 → 跑通过 → commit `feat(comfyui): port applyOverrides + LoRA chain rewiring`

---

### Task 5: loadTemplate + 目录扫描 (scanWorkflowTemplates / scanGuides)

**Files:**
- Modify: `src/plugins/comfy-ui/template-loader.ts`
- Modify: `src/plugins/comfy-ui/__tests__/template-loader.test.ts`（加扫描用例）

**移植源：** `template_loader.py` 的 `load_template` / `load_all`；`__init__.py` 的 guides 列举逻辑（`_list_guide_names`）。

**Interfaces (Produces):**
```ts
export function loadTemplate(name: string, jsonText: string): TemplateBindings  // 组装：loadRaw→find*→extract*→scanLoraPool→trace*，含 locked/suppress-pool 逻辑
export function scanWorkflowTemplates(dir: string, opts?: { server?: string }): TemplateBindings[]  // 扫 *.json，逐个 loadTemplate，单文件失败仅警告跳过，重名警告，按 name 返回数组
export function scanGuides(dir: string): Guide[]  // 扫 *.md，返回 { name: stem, content }[]
```

**关键测试：** 用 node `fs` + `os.tmpdir()` 写临时文件后扫描（参考 vitest 既有用例风格；可用 `node:fs`/`node:os`/`node:path`）。
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanWorkflowTemplates, scanGuides, loadTemplate } from '../template-loader'
import { minimalWorkflow, workflowWithDanglingLora } from './fixtures'

describe('loadTemplate', () => {
  it('assembles bindings from a minimal workflow', () => {
    const t = loadTemplate('w', JSON.stringify(minimalWorkflow()))
    expect(t).toMatchObject({ name: 'w', positiveNode: '6', negativeNode: '7', samplerNode: '3', latentNode: '5', seedPrompt: 'masterpiece, 1girl', modelSummary: 'anima.safetensors' })
    expect(t.seedNegative).toContain('low quality')
  })
  it('populates the LoRA pool from a dangling loader', () => {
    const t = loadTemplate('w', JSON.stringify(workflowWithDanglingLora()))
    expect(t.availableLoras).toHaveLength(1)
    expect(t.loraLocked).toBe(false)
  })
})

describe('scanWorkflowTemplates', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cfwf-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  it('loads all *.json, tags server, skips broken files', () => {
    writeFileSync(join(dir, 'good.json'), JSON.stringify(minimalWorkflow()))
    writeFileSync(join(dir, 'broken.json'), '{not json')
    const ts = scanWorkflowTemplates(dir, { server: 'box1' })
    expect(ts.map((t) => t.name)).toEqual(['good'])
    expect(ts[0].server).toBe('box1')
  })
})

describe('scanGuides', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cfgd-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  it('reads *.md as { name, content }', () => {
    writeFileSync(join(dir, 'anima.md'), '# anima tags')
    const gs = scanGuides(dir)
    expect(gs).toEqual([{ name: 'anima', content: '# anima tags' }])
  })
})
```

**实现要点：** `loadTemplate` 的 locked/suppress 逻辑对照 Hermes `load_template`：若 wired LoRA 存在则 locked + 空 pool；若有 dangling pool 但 model/clip source 无法 trace 则抑制 pool 并记 reason。`scanWorkflowTemplates` 重名（同 stem）时 `logger.warn`——但纯函数无 logger，改为收集后用 `console.warn` 或返回时检测重复并跳过后者+warn（实施者择一，保持「重名不静默」）。`server` 注入到每个 binding。目录不存在返回 `[]`。

- [ ] **Step 1–5:** 写测试 → 跑失败 → 移植 → 跑通过 → commit `feat(comfyui): port loadTemplate + directory scanners (scanWorkflowTemplates/scanGuides)`

---

### Task 6: ComfyUIClient（基于 ctx.http）

**Files:**
- Create: `src/plugins/comfy-ui/client.ts`
- Create: `src/plugins/comfy-ui/__tests__/client.test.ts`

**移植源：** `~/.hermes/plugins/comfyui/client.py`（`submit` / `poll_until_done` / `fetch_image` + 错误类型）。测试源：`tests/test_client.py`。

**Interfaces (Produces):**
```ts
export type ComfyErrorType = 'cf_access' | 'comfyui_validation' | 'timeout' | 'network' | 'comfyui_error'
export class ComfyError extends Error { type: ComfyErrorType; constructor(message: string, type: ComfyErrorType) }

export class ComfyUIClient {
  constructor(http: HTTP)   // 传入已 extend 好的 http 实例（带 baseURL/headers/timeout）
  submit(apiFormat: Record<string, any>, clientId: string): Promise<string>          // POST /prompt → prompt_id
  pollUntilDone(promptId: string, timeoutS: number, intervalS?: number): Promise<Record<string, any>>  // GET /history/{id} 轮询
  fetchImage(p: { filename: string; subfolder: string; type: string }): Promise<ArrayBuffer>  // GET /view
}
```

**关键测试（client.test.ts）：** 用 fake http（不起真服务器）。fake：一个对象实现 `get`/`post`，按 url 返回预设响应或抛 `HTTP.Error` 形态错误（带 `response.status`）。
```ts
import { describe, it, expect, vi } from 'vitest'
import { ComfyUIClient, ComfyError } from '../client'

function fakeHttp(handlers: { post?: any; get?: any }): any {
  return {
    post: handlers.post ?? vi.fn(),
    get: handlers.get ?? vi.fn(),
    isError: (e: any) => !!e?.__isHttpError,
  }
}
function httpError(status: number) { return { __isHttpError: true, response: { status }, message: `HTTP ${status}` } }

describe('ComfyUIClient.submit', () => {
  it('returns prompt_id on success', async () => {
    const http = fakeHttp({ post: vi.fn().mockResolvedValue({ data: { prompt_id: 'pid-1' } }) })
    const c = new ComfyUIClient(http)
    expect(await c.submit({}, 'cid')).toBe('pid-1')
  })
  it('maps 400 to comfyui_validation', async () => {
    const http = fakeHttp({ post: vi.fn().mockRejectedValue(httpError(400)) })
    await expect(new ComfyUIClient(http).submit({}, 'cid')).rejects.toMatchObject({ type: 'comfyui_validation' })
  })
  it('maps 403 to cf_access', async () => {
    const http = fakeHttp({ post: vi.fn().mockRejectedValue(httpError(403)) })
    await expect(new ComfyUIClient(http).submit({}, 'cid')).rejects.toMatchObject({ type: 'cf_access' })
  })
})

describe('ComfyUIClient.pollUntilDone', () => {
  it('returns the history entry when status success', async () => {
    const get = vi.fn().mockResolvedValue({ data: { 'pid-1': { status: { status_str: 'success' }, outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } } } })
    const entry = await new ComfyUIClient(fakeHttp({ get })).pollUntilDone('pid-1', 5, 0)
    expect(entry.outputs['9'].images[0].filename).toBe('a.png')
  })
  it('throws comfyui_validation when status_str error', async () => {
    const get = vi.fn().mockResolvedValue({ data: { 'pid-1': { status: { status_str: 'error', messages: [['x', {}]] } } } })
    await expect(new ComfyUIClient(fakeHttp({ get })).pollUntilDone('pid-1', 5, 0)).rejects.toMatchObject({ type: 'comfyui_validation' })
  })
  it('throws timeout when never completes', async () => {
    const get = vi.fn().mockResolvedValue({ data: {} })   // 始终无 entry
    await expect(new ComfyUIClient(fakeHttp({ get })).pollUntilDone('pid-1', 0, 0)).rejects.toMatchObject({ type: 'timeout' })
  })
})

describe('ComfyUIClient.fetchImage', () => {
  it('requests /view with params and returns arraybuffer', async () => {
    const buf = new ArrayBuffer(4)
    const get = vi.fn().mockResolvedValue({ data: buf })
    const c = new ComfyUIClient(fakeHttp({ get }))
    const out = await c.fetchImage({ filename: 'a.png', subfolder: 's', type: 'output' })
    expect(out).toBe(buf)
    expect(get).toHaveBeenCalledWith('/view', expect.objectContaining({ params: { filename: 'a.png', subfolder: 's', type: 'output' }, responseType: 'arraybuffer' }))
  })
})
```

**实现要点：** `ctx.http` 的方法签名：`http.post(url, data, config?)`、`http.get(url, config?)`，返回 `{ data, status, ... }`（`HTTP.Response`）。错误用 `http.isError(e)` 判断后读 `e.response?.status` 分类（401/403→cf_access，400→comfyui_validation，`e.code==='ETIMEDOUT'`→timeout，其它→comfyui_error）。`pollUntilDone` 用 `Date.now()` deadline + `await new Promise(r => setTimeout(r, intervalS*1000))`（intervalS=0 时立即重试，便于测试）。轮询读 `data[promptId].status.status_str`。

- [ ] **Step 1–5:** 写测试 → 跑失败（`npx vitest run src/plugins/comfy-ui/__tests__/client.test.ts`）→ 移植 → 跑通过 → commit `feat(comfyui): ComfyUIClient (submit/poll/fetch) over ctx.http with error classification`

---

### Task 7: LoRA 入参校验 + 三命令 + 插件装配 + 注册

**Files:**
- Create: `src/plugins/comfy-ui/lora-validate.ts`
- Create: `src/plugins/comfy-ui/__tests__/lora-validate.test.ts`
- Modify: `src/plugins/comfy-ui/index.tsx`（Config 完整化、`static scanWorkflowTemplates`/`scanGuides`、三命令注册、client 装配、出图）
- Modify: `src/index.ts`（注册 `ctx.plugin(PluginComfyUI, {...})`，与 llm 平级；默认不配置后端时插件应惰性无害——见要点）

**移植源：** `__init__.py` 的 `_validate_loras_arg`（→ `lora-validate.ts`）、`_build_template_info`（templates 命令）、`_handle_comfyui_*`（三命令）。测试源：`tests/test_lora_generate_handler.py`（校验部分）。

**Interfaces (Produces):**
```ts
// lora-validate.ts
export function validateLorasArg(
  raw: unknown,
  t: TemplateBindings
): { loras: OverrideArgs['loras']; error: string | null }
```

**关键测试（lora-validate.test.ts）：** 移植 `test_lora_generate_handler.py` 的校验用例：
```ts
import { describe, it, expect } from 'vitest'
import { validateLorasArg } from '../lora-validate'
import { loadTemplate } from '../template-loader'
import { workflowWithDanglingLora, minimalWorkflow } from './fixtures'

const poolT = loadTemplate('p', JSON.stringify(workflowWithDanglingLora()))

describe('validateLorasArg', () => {
  it('null/empty → no loras, no error', () => {
    expect(validateLorasArg(null, poolT)).toEqual({ loras: null, error: null })
    expect(validateLorasArg([], poolT)).toEqual({ loras: null, error: null })
  })
  it('rejects unknown lora name', () => {
    expect(validateLorasArg([{ name: 'nope.safetensors' }], poolT).error).toMatch(/unknown/i)
  })
  it('rejects duplicate names', () => {
    const r = validateLorasArg([{ name: 'detail.safetensors' }, { name: 'detail.safetensors' }], poolT)
    expect(r.error).toMatch(/more than once|duplicate/i)
  })
  it('rejects non-number strength', () => {
    expect(validateLorasArg([{ name: 'detail.safetensors', strengthModel: 'x' as any }], poolT).error).toMatch(/number/i)
  })
  it('rejects loras against a template without pool', () => {
    const noPool = loadTemplate('np', JSON.stringify(minimalWorkflow()))
    expect(validateLorasArg([{ name: 'detail.safetensors' }], noPool).error).toBeTruthy()
  })
  it('accepts a valid lora from the pool', () => {
    const r = validateLorasArg([{ name: 'detail.safetensors', strengthModel: 0.6 }], poolT)
    expect(r.error).toBeNull()
    expect(r.loras).toEqual([{ name: 'detail.safetensors', strengthModel: 0.6 }])
  })
})
```

**命令注册（index.tsx，无独立单测，靠集成验证）：**
- `comfyui.templates`：渲染每个 template 的 info（model/default_size/aspect_ratios/defaults/seedPrompt/seedNegative/availableLoras/loraLocked）+ `guides_available`。返回文本（markdown）。
- `comfyui.guide <series:string>`：stem 校验后返回对应 guide.content；不存在报可用清单。
- `comfyui.generate`：参数 `<template> <prompt:text>` + options `negative/aspect_ratio/width/height/steps/cfg/seed/loras/timeout`。流程：找 template → 校验尺寸（成对、8 倍数、[64,4096]）→ `validateLorasArg` → seed 缺省随机 → `applyOverrides` → `client.submit` → `pollUntilDone` → 取首个含 images 的 output → `fetchImage` → `session.send(h.image(\`data:image/png;base64,${Buffer.from(buf).toString('base64')}\`))`。错误按 `ComfyError.type` 返回清晰文本。
- 三命令都用 `{ hideForHuman: true, descriptionForAgents: '<见 spec B 表格>', helpForAgents: '<参数细节>' }`。
- `loras` option 类型 `string`（JSON 字符串），命令内 `JSON.parse`（容错：已是对象/数组则直接用）。

**装配要点：**
- `static scanWorkflowTemplates = scanWorkflowTemplates`（re-export 静态方法，转发到 template-loader 的实现）；`static scanGuides = scanGuides`。
- client 装配：`this.client = new ComfyUIClient(ctx.http.extend({ ...config.http, headers: { 'User-Agent': 'sili-comfyui/0.1', ...config.http?.headers } }))`。仅当 `config.http?.baseURL` 存在时才注册 generate 的真实执行；无 baseURL 时命令仍注册但执行返回「未配置后端」提示（保持 catalog 一致、不抛）。
- `src/index.ts`：`import PluginComfyUI from '~/comfy-ui'` + 在合适位置 `ctx.plugin(PluginComfyUI, { /* 本地默认：不配 http 则插件惰性 */ })`。**默认注册时不带后端配置**（生产环境另行在部署配置注入 http + workflows），确保 dev/CI 启动不报错。

- [ ] **Step 1: 写 lora-validate 失败测试**（上方）
- [ ] **Step 2: 跑确认失败** `npx vitest run src/plugins/comfy-ui/__tests__/lora-validate.test.ts`
- [ ] **Step 3: 实现 `lora-validate.ts`**（移植 `_validate_loras_arg`）
- [ ] **Step 4: 跑确认通过**
- [ ] **Step 5: 实现三命令 + 装配 + 注册**（index.tsx + src/index.ts）
- [ ] **Step 6: 全量测试 + 类型检查**
  Run: `npx vitest run src/plugins/comfy-ui/__tests__`
  Expected: 全绿。
  Run: `npx tsc --noEmit -p . 2>&1 | grep "comfy-ui" || echo "no new errors"`
  Expected: 无 comfy-ui 相关错误。
- [ ] **Step 7: 提交** `git add src/plugins/comfy-ui src/index.ts && git commit -m "feat(comfyui): LoRA arg validation + three commands + plugin wiring + registration"`

---

## 集成验证（全部 task 后，docker，由调度者执行）

1. `npx vitest run src/plugins/comfy-ui/__tests__` + `npx vitest run src/plugins/llm/__tests__/command-catalog.test.ts` 全绿。
2. `npx tsc --noEmit -p .` 无新增错误（忽略已知 `chat.tsx:67 minInterval` 噪音）。
3. `docker compose restart core`，启动日志含 `comfyui: N templates, M guides` 与 `command catalog rebuilt`。
4. 人类 `;help` 不出现 `comfyui.*`（`hideForHuman` 生效）；`;llm.catalog` 后 agent catalog 概览含 `comfyui.generate` 等且为 skill 风格描述。
5. （需真实后端 + 一个 workflow JSON 时）`;chat 帮我画一只猫` 触发 agent 调 `comfyui.generate` 出图。无后端时验证命令存在 + 返回「未配置后端」提示，不崩。

## Self-Review

- **Spec coverage**：配置/HTTP.Config 认证(Task1+7)、scanWorkflowTemplates/scanGuides(Task5)、节点识别(Task2)、defaults/summary/LoRA池/trace(Task3)、applyOverrides+LoRA链(Task4)、client(Task6)、三命令+LoRA校验+出图+注册(Task7)、basicAuth/UA(Task1+7)、aspect_ratio(Task1+4)。spec B 全章节有对应 task。✓
- **Placeholder scan**：命令 action 体（Task7 Step5）以散文 + 流程描述给出而非逐行代码——因其是集成装配（多函数编排 + koishi API），实施者照 spec B「命令」「出图」节 + Hermes `_handle_comfyui_*` 移植；其余纯逻辑 task 均有确切测试与签名。LoRA 校验、所有解析函数有完整测试。可接受（移植规格型 plan）。
- **Type consistency**：`TemplateBindings`/`AvailableLora`/`Guide`/`OverrideArgs`/`ComfyError`/`ComfyUIClient` 跨 task 一致；camelCase 字段（strengthModel 等）统一。✓
