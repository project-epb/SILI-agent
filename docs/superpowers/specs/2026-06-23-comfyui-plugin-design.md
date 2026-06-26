# ComfyUI 插件（SILI）

将 Hermes 的 Python `comfyui` 插件移植到 SILI（koishi / TypeScript），让 SILI 具备 AI 画图能力。

**依赖**：本 spec 依赖 `2026-06-23-llm-catalog-agent-views-design.md`（catalog 双视图）先落地——ComfyUI 的命令以 `hideForHuman` + `descriptionForAgents` 形式注册。

## 形态与定位

- 独立 koishi plugin `src/plugins/comfy-ui/`，在 `src/index.ts` 里与 `PluginLLM` **平级注册**（`ctx.plugin(PluginComfyUI, {...})`）。
- **不 inject llm，不碰 `ctx.llm`**。agent 通过现有 command catalog + `execute_koishi_command` 调用其命令；出图的 ref 化、catalog 暴露由 llm 那侧的现成机制自动兜底。
- **inject `http`**（`@cordisjs/plugin-http` 的 HTTP service，SILI `index.ts` 已 `ctx.plugin(PluginHTTP)`）。`static inject = { http: { required: true } }`。
- 参考实现：`~/.hermes/plugins/comfyui/`（`client.py` / `template_loader.py` / `__init__.py`）。本 spec 是其概念移植，非逐行翻译。

## 配置（单后端）

```ts
import PluginComfyUI from '~/comfy-ui'
import { resolve } from 'node:path'

ctx.plugin(PluginComfyUI, {
  // 复用 koishi HTTP service 的标准 HTTP.Config（baseURL / headers / timeout）
  http: {
    baseURL: 'https://comfy.example',
    headers: { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret },
    // headers: PluginComfyUI.basicAuth('user', 'pass'),   // basic 那台
    timeout: 30_000,                                        // 单 HTTP 请求超时
  },
  workflows: PluginComfyUI.scanWorkflowTemplates(
    resolve(ctx.baseDir, 'data/comfy/workflows')
  ),
  guides: PluginComfyUI.scanGuides(resolve(ctx.baseDir, 'data/comfy/guides')),
  defaultGenerateTimeoutS: 600,    // 整轮生成轮询超时（秒），上限 600
})
```

设计要点：

- **认证 = HTTP 请求头，统一收进 `http.headers`**。三种「鉴权方式」本质都是往请求塞一组固定头：zero-trust 是 `CF-Access-Client-Id`/`CF-Access-Client-Secret`，basic 是 `Authorization: Basic base64(user:pass)`，自定义就是任意头。不搞 `auth: { type }` 判别联合 + 多套注入分支（过度抽象）；直接复用 `HTTP.Config`，认证逻辑塌缩为「default UA + 用户 headers 合并进每个请求」，零分支。
- **`basicAuth` helper**：raw header 里让用户自己 `base64(user:pass)` 易错、不直观，故导出 `PluginComfyUI.basicAuth(username, password) → { Authorization: 'Basic ...' }` 供拼装。CF token 键名固定、直接写 headers 即可，无需 helper。与「核心吃标准对象、便利构造交给导出函数」哲学一致（同 `scanWorkflowTemplates`）。
- **User-Agent 默认值**：Cloudflare 的 Browser Integrity Check（error 1010）会在 Service Token 校验前拦截裸 UA（Hermes 踩过）。故 client 构造时默认补 `User-Agent: sili-comfyui/0.1`（若 `http.headers` 未提供），实现为 `headers: { 'User-Agent': 'sili-comfyui/0.1', ...config.http?.headers }`，用户可覆盖。这与认证方式无关，统一 headers 后更顺。
- **首版单后端**。一次只配一台。用户有两台 ComfyUI（一台 CF Zero Trust、一台 basic auth、均不在 SILI 同网络），先接一台；多后端路由（template→server 绑定）是后续话题，本版不做。
- **配置注入式，核心不碰文件系统**。插件只吃标准对象 `workflows: TemplateBindings[]` / `guides: Guide[]`。`scanWorkflowTemplates(dir)` / `scanGuides(dir)` 是导出的**静态方法**，把 Hermes 的目录扫描 + 启发式解析封装起来，供 `index.ts` 调用生成配置；使用方也可完全绕过它手写配置。
- 模板目录默认放 `ctx.baseDir/data/comfy/workflows`（容器里 `/app/data`，宿主机 `.volumns/core/comfy/workflows`，已确认持久化挂载）；具体路径由调用方决定，插件不假设。
- **代理（proxy）本版不做**：`HTTP.Config@0.6.3` 无 `proxyAgent` 字段。未来若需走代理，通过监听 `http/fetch-init` 事件注入 `RequestInit.dispatcher`，不改本插件配置面。

## 命令（注册为纯 agent 工具）

三条子命令挂在顶层 `comfyui` 命名空间下，全部以 `hideForHuman: true` 注册（人类 `help` 不显示；agent catalog 可见），description 用 `descriptionForAgents` 写 skill/trigger 风格。

| 命令 | descriptionForAgents（skill 风格，概览触发线索） |
|---|---|
| `comfyui.generate` | 「当用户需要用 AI 生成 / 绘制图片（插画、头像、概念图等）时调用。调用前先用 `comfyui.templates` 选模板、必要时用 `comfyui.guide` 查该模型的提示词写法。」 |
| `comfyui.templates` | 「生成图片前先调用：列出可用画风模板及各自的种子提示词、默认尺寸与采样参数，据此决定 `comfyui.generate` 的入参。」 |
| `comfyui.guide` | 「写画图 prompt 拿不准某模型怎么吃 tag 时调用：返回该模型系列的提示词写法指南（tag 约定、推荐前缀、风格结构）。」 |

参数级细节（aspect_ratio 尺寸对照、loras JSON 格式、何时别覆盖 negative）放进各 option 的描述 + `helpForAgents`/`.usage()`，由 `renderCatalogEntryDetail` 在 agent `help <cmd>` 时展开——概览不背这些负担。

### `comfyui.templates`

无参。返回每个模板的：`model`（loader 文件名摘要）、`default_size`、支持的 `aspect_ratios`、`defaults`（steps/cfg/sampler_name/scheduler）、`seed_prompt`、`seed_negative`、`available_loras`（名 + 推荐 strength）、`lora_locked`，以及 `guides_available`（guide 名清单）。等价 Hermes `comfyui_list_templates`。

### `comfyui.guide <series>`

参数 `series`（guide 文件 stem）。返回对应 markdown 全文。做 stem 校验（无斜杠、无 `.md` 后缀），不存在时报可用清单。等价 Hermes `comfyui_model_guide`。

### `comfyui.generate`

参数：

- `template`（必）：模板名。
- `prompt`（必）：完整正向提示词（建议含模板 `seed_prompt` 前缀）。
- option `negative`：缺省用模板 `seed_negative`。
- option `aspect_ratio`：枚举，NovelAI 风格三档九值（见下 `ASPECT_RATIO_MAP`）。
- option `width` / `height`：自定义尺寸（成对、8 的倍数、范围 [64,4096]），优先于 `aspect_ratio`。
- option `steps` / `cfg` / `seed`：采样覆盖，缺省用模板默认；`seed` 缺省随机。
- option `loras`：**JSON 字符串**，命令内 `JSON.parse` 成 `{name, strength_model?, strength_clip?}[]`（agent 经 `execute_koishi_command` 传 options object 时也兼容直接对象/数组）。校验见「LoRA」。
- option `timeout`：秒，默认 `defaultGenerateTimeoutS`，上限 600。

执行：`apply_overrides` 生成 API-format workflow → `client.submit` → `client.pollUntilDone` → 取首个含 images 的 output 节点 → `client.fetchImage` 拿 PNG bytes → 转 base64 data URI → `session.send(<image src="data:image/png;base64,...">)`。等价 Hermes `comfyui_generate`，但**不写本地缓存文件**（Hermes 落盘是因为它返回路径给 agent；这里直接发图，ref 化交给 llm 侧）。

## 出图与 image-cache

`comfyui.generate` 直接 `session.send` 一个 `<image src="data:...">`：

- **agent 触发时**：`execute-koishi-command.ts` 劫持 `bot.sendMessage` 捕获这条侧通道输出，并调 `ctx.llm.imageRefs.replaceDataUrisWithRefs()` 把 base64 转短 ref 交给 agent；agent 转发时 llm 流式层 `resolveRefsToDataUris` 还原真正发图。**ComfyUI 插件全程不碰 image-cache。**
- **人类直接触发时**（`hideForHuman` 不阻止人类显式 `comfyui.generate ...` 执行，只是 help 不列）：就是普通 `session.send` 发图。

> 注意 koishi satori 的图片元素是 `<image src=...>`（见项目 CLAUDE.md 的 JSX 说明），不是 HTML `<img>`。execute-koishi-command 的 `replaceDataUrisWithRefs` 按 data URI 文本匹配，与标签名无关，故仍能 ref 化。

## 模块结构

移植 Hermes 三文件 → TS：

```
src/plugins/comfy-ui/
├── index.tsx           插件入口 + 静态方法 scanWorkflowTemplates/scanGuides + Config + 三命令注册
├── client.ts           ComfyUIClient：submit /prompt → poll /history → fetch /view + auth 注入 + 错误类型
├── template-loader.ts  scanWorkflowTemplates + TemplateBindings + applyOverrides + ASPECT_RATIO_MAP + LoRA 池扫描/链重连
├── commands.tsx        三命令 action（或拆 commands/ 子目录）
└── __tests__/          vitest：模板解析 / LoRA 链 / applyOverrides / aspect ratio / auth header
```

`index.tsx` 继承 `~/_boilerplate`（与其余 SILI 插件一致）。

## client（移植 `client.py`）

- **基于 koishi HTTP service**：构造时 `this.http = ctx.http.extend({ ...config.http, headers: { 'User-Agent': 'sili-comfyui/0.1', ...config.http?.headers } })`，得到预配好 baseURL / 认证头 / timeout 的实例，后续每个请求自动带上。无需自管 base URL 拼接或 header 注入。
- API：
  - `submit(apiFormat, clientId)` → `http.post('/prompt', { prompt, client_id })`，取 `prompt_id`。
  - `pollUntilDone(promptId, timeoutS, intervalS=2)` → 轮询 `http.get('/history/' + id)`，看 `status.status_str`：`success` 返回 entry，`error` 抛 `ComfyValidationError`，其它继续轮询到 deadline。**轮询而非 websocket**（移植 Hermes）。
  - `fetchImage({filename, subfolder, type})` → `http.get('/view', { params, responseType: 'arraybuffer' })` 拿二进制（`HTTP.ResponseTypes.arraybuffer` 原生支持）。
- **错误分类**：HTTP service 失败抛 `HTTP.Error`（`ctx.http.isError(e)`），带 `response.status`。据 status 映射成给 agent 的清晰错误串 + `error_type`（移植 Hermes 的语义，但分类源从「自造异常」改为「读 HTTPError.response.status」）：
  - 401/403 → `cf_access`（Cloudflare/Service Token/policy 问题）
  - 400 → `comfyui_validation`（workflow schema/参数）
  - `ETIMEDOUT` / 轮询 deadline → `timeout`
  - 其它 → `comfyui_error`
  - 轮询中 `status_str === 'error'`（workflow 执行失败，HTTP 仍 200）→ `comfyui_validation`，附 ComfyUI messages。

## template-loader（移植 `template_loader.py`）

逐项移植成 TS（这是整个插件逻辑密度最高处，也是测试重点）：

- `loadRaw` / 结构校验（顶层 dict by node id，每节点含 `class_type`）。
- `findSamplerNode`（`KSampler*`）、`findLatentNode`（`EmptyLatentImage` / `EmptySD3LatentImage`）。
- `findPromptNodes` 四级启发式：①KSampler.positive/.negative 拓扑回溯 → ②`_meta.title` 关键词（positive/正面 vs negative/反向…）→ ③恰好 2 个 CLIPTextEncode 时按负面关键词文本推断 → ④否则 `AmbiguousPromptError`。
- `extractDefaults`（仅 widget 标量，跳过 link）、`extractModelSummary`（loader 文件名）。
- LoRA 池：`scanLoraPool`（识别悬空 `LoraLoader`；存在已接线的则 `lora_locked`）、`traceModelSource` / `traceClipSource`（穿透 LoraLoader 跳点）。
- `applyOverrides`：深拷贝 raw → 覆盖 prompt/negative/sampler widgets/尺寸 → 尺寸优先级 `width/height` > `aspect_ratio` > 模板默认 → LoRA 链 `applyLoraChain`（按 agent 给定顺序串联悬空 LoraLoader 并重定向 model/clip 引用）。
- `scanWorkflowTemplates(dir)`：扫 `*.json`，逐文件 `loadTemplate`，单文件失败仅警告跳过，返回 `TemplateBindings[]`；**重名报警**（多模板同 stem）。
- `ASPECT_RATIO_MAP`：三档九值（NORMAL `portrait 832×1216` / `landscape 1216×832` / `square 1024×1024`；LARGE `1024×1536` / `1536×1024` / `1472×1472`；SMALL `512×768` / `768×512` / `640×640`）。

## LoRA 校验（移植 `_validate_loras_arg`）

命令层校验 agent 给的 `loras`：模板 `lora_locked` 拒绝；model/clip source 不可解析拒绝；名必须在 `available_loras` 池内；不可重复；strength 必须是数。校验后交 `applyOverrides`。`loras` 缺省 / 空 = 无 LoRA（行为与不传一致）。

## scanGuides（移植 guides 目录逻辑）

`scanGuides(dir)` 扫 `*.md`，返回 `{ name: stem, content }[]`。`comfyui.guide` 与 `comfyui.templates` 的 `guides_available` 消费它。

## 测试

移植 Hermes `tests/` → `__tests__/`（vitest）：

- template 解析：四级启发式各分支、缺 sampler、ambiguous、`EmptySD3LatentImage`。
- `extractDefaults` 跳过 link、`extractModelSummary` 拼接。
- LoRA：`scanLoraPool` 悬空 vs 锁定、`traceModelSource`/`traceClipSource` 穿透、`applyLoraChain` 串联与引用重定向。
- `applyOverrides`：尺寸优先级、prompt 替换不追加、负向仅显式覆盖、seed 注入。
- `basicAuth(user, pass)` helper 正确拼出 `Authorization: Basic base64(user:pass)`。

client 的网络层（submit/poll/fetch，基于 `ctx.http`）按 SILI 惯例不强求单测（provider 层同样无单测），靠一次真实生成验证。UA 默认值 + headers 合并由 `ctx.http.extend` 的 `mergeConfig` 保证，无需自测。

## 验收

1. `npx vitest run src/plugins/comfy-ui/__tests__` 全绿。
2. `npx tsc --noEmit` 无新增 comfy-ui 相关错误。
3. 真实链路：配置一台后端 + 放一个 API-format workflow → `;comfyui.templates` 列出 → `;chat 帮我画一只猫` 触发 agent 调 `comfyui.generate` → 用户收到图。
4. 人类 `help` 里不出现 `comfyui.*`（`hideForHuman` 生效）；agent catalog 概览里出现且 description 为 skill 风格。

## 明确不做（YAGNI）

- 多后端路由 / template→server 绑定。
- websocket 进度推送（用轮询）。
- 本地落盘缓存生成图（直接发图 + llm 侧 ref 化）。
- ControlNet / img2img / 高级工作流参数（首版只覆盖 txt2img 三件套 + LoRA）。
