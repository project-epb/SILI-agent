# comfyui 插件

koishi 插件：驱动远程 ComfyUI 实例（HTTP API）生成图片。命令既可被 LLM agent 经 koishi 命令系统调用，也可人类直接调。基于预导出的 **API-format workflow 模板** + 启发式节点识别 + LoRA 池。

## 命令

| 命令 | 作用 |
|---|---|
| `comfyui.templates` | 列出可用 workflow 模板：模型摘要、种子提示词、默认采样参数、支持的 aspect_ratio、可用 LoRA、`guides_available` |
| `comfyui.guide <series>` | 返回某模型系列的 markdown 提示词指南 |
| `comfyui.generate <template> <prompt>` | 生成图片。options：`negative` / `aspect_ratio` / `width` `height` / `steps` / `cfg` / `seed` / `loras`(JSON) / `timeout`。出图后回带 `seed`/耗时/`prompt_id` 元信息 |

命令以「agent 工具」风格注册：带 `descriptionForAgents`（给 LLM 看的触发文案）+ `hideForHuman`（对人类 `help` 隐藏）。这两个是 `Command.Config` 扩展字段，由宿主的 LLM catalog 框架提供；宿主不支持则忽略，不影响功能。

## 配置

```ts
ctx.plugin(PluginComfyUI, {
  // 认证 = HTTP.Config 的 headers（baseURL / headers / timeout）
  http: {
    baseURL: 'https://comfy.example',
    headers: { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret }, // CF Zero Trust
    // headers: PluginComfyUI.basicAuth('user', 'pass'),  // Basic Auth；或写任意自定义头
    timeout: 30_000,
  },
  // 标准对象；用导出的扫描器从目录构建，或手写
  workflows: PluginComfyUI.scanWorkflowTemplates(resolve(ctx.baseDir, 'data/comfyui/workflows')),
  guides: PluginComfyUI.scanGuides(resolve(ctx.baseDir, 'data/comfyui/guides')),
  defaultGenerateTimeoutS: 600,   // 整轮生成轮询超时（秒），上限 600

  // 频道白名单：只在这些频道启用三命令。群=群号，私聊=private:<用户号>；不配=不限。
  allowedChannels: ['123456789', 'private:10001'],

  // 访问控制（防刷爆显卡）：施加在 generate 命令层（minInterval/maxUsage 需 koishi-plugin-rate-limit）。
  generate: {
    authority: 1,        // 调用所需 authority 等级，默认 1
    minInterval: 30_000, // 两次调用最小间隔（ms），默认 0（不限）
    maxUsage: 0,         // 每用户每日次数上限，默认 0（不限）
  },

  // 提示词过滤：blacklist 命中即拒绝、force* 追加强制词，Computed 可按群。
  filter: {
    blacklist: (s) => nsfwChannels.includes(s.channelId) ? ['nsfw', 'nude'] : [],
    forceNegative: 'nsfw, nude',
  },
})
```

要点：

- **认证 = HTTP 请求头**：CF Zero Trust 写 `CF-Access-Client-*` 两个头；Basic Auth 用导出的 `PluginComfyUI.basicAuth(user, pass)`；其它写任意头。client 默认补 `User-Agent`（绕过 Cloudflare Browser Integrity Check，可被 headers 覆盖）。
- **配置注入式**：核心只吃标准对象 `workflows`/`guides`；`PluginComfyUI.scanWorkflowTemplates(dir)` / `scanGuides(dir)` 是导出静态方法，扫目录构建配置，也可手写绕过。
- **惰性无害**：不配 `http.baseURL` 时插件仍加载、命令仍注册，`generate` 返回「未配置后端」提示而非崩溃。
- **访问控制**：`generate.{authority,minInterval,maxUsage}` 限权限/频率/每日次数。agent 经命令系统调用时沿用调用者身份，故按调用者检查。`templates`/`guide` 只读不限。
- **频道白名单**：`allowedChannels` 用命令 **action 内 `channelId` 检查**实现，而非 ctx selector filter——koishi 4.18 的 `ctx.guild/channel().plugin()` 对命令不生效（命令注册到全局 commander，agent 的 `session.execute` 也不走 selector），只有写在 action 里才拦得住人类和 agent。

## 添加 workflow 模板

1. 在 ComfyUI Web UI 调好工作流，**Workflow → Export (API)**（API 格式，不是默认的 GUI 格式 JSON）。
2. 把 `<name>.json` 放进 `scanWorkflowTemplates` 指向的目录，重启。
3. 扫描器自动识别 positive/negative `CLIPTextEncode`、`KSampler`、`EmptyLatentImage` 节点（四级启发式：KSampler 拓扑回溯 → `_meta.title` 关键词 → 负面关键词推断 → 否则跳过并警告）。

模板名要求全局唯一（重名保留首个并警告）。

## LoRA 池

让 agent 可在模板上动态叠加 LoRA：在 workflow 里放**悬空的** `LoraLoader` 节点（`model`/`clip` 端口不接线），设好 `lora_name` 与推荐 strength，导出 API JSON。ComfyUI 执行器从输出节点反向遍历，悬空节点不参与生成；调 `generate(loras=[...])` 时插件才把选中的 LoRA 串进主路径。

若模板已有接线的 `LoraLoader`（作者预调的固定组合），该模板 `lora_locked`，拒绝叠加额外 LoRA。

## 模型提示词指南（guide）

把 `<series>.md` 放进 `scanGuides` 指向的目录，`comfyui.guide <series>` 返回其内容，`comfyui.templates` 的 `guides_available` 列出可用 guide 名。

## 提示词过滤 / 扩展点

两层机制限制或改写 `comfyui.generate` 的入参（禁词、强制注入负面词等）。

### event：`comfyui/before-generate`

参数校验之后、真正生成之前 emit（`ctx.serial`，async serial）。监听器可就地改 `args.prompt` / `args.negative` / 采样参数，或**返回非空字符串 = 拒绝**本次生成（原因回给调用方）；抛错同样视为拒绝：

```ts
ctx.on('comfyui/before-generate', async ({ session, template, args }) => {
  if (await isBanned(session.channelId, args.prompt)) return '本频道禁止该内容'
  args.negative = `${args.negative ?? template.seedNegative}, watermark`
})
```

### 内置 filter 配置（声明式便利层）

底层是插件自注册的一个 `comfyui/before-generate` 监听器，覆盖最常见的禁词/强制词：

```ts
filter: {
  blacklist: (s) => nsfwChannels.includes(s.channelId) ? ['nsfw', 'nude'] : [], // Computed
  forceNegative: 'nsfw, nude, lowres',  // 追加进 negative（保留模板 seed_negative）
  forcePositive: 'masterpiece',          // 追加进 prompt
}
```

`Computed<T> = T | ((session) => T)`，支持按频道/按人。`blacklist` 命中任一词即**拒绝生成**；`force*` 追加强制词。需要清洗/正则/外部审核 API 等复杂逻辑，用上面的 event 自己写监听器。

## 出图

`comfyui.generate` 完成后 `session.send(h.image('data:image/png;base64,...'))` 发图，命令返回值携带 `seed`/耗时/`prompt_id` 文本元信息。

## 架构 / 模块

```
index.tsx          插件入口：Config + static scanWorkflowTemplates/scanGuides/basicAuth + 命令注册 + client 装配 + 内置 filter 监听器
client.ts          ComfyUIClient：基于 ctx.http.extend，submit /prompt → poll /history → fetch /view，错误按 HTTP status 分类
template-loader.ts 节点识别 + 默认值/模型摘要抽取 + LoRA 池扫描/source trace + applyOverrides(含 LoRA 链重连) + 目录扫描
auth.ts            basicAuth helper（与 index 分离，便于不依赖 koishi 单测）
lora-validate.ts   命令层 LoRA 入参校验
filter.ts          内置提示词 filter 纯函数（applyBuiltinFilter）
__tests__/         vitest：解析 / LoRA / applyOverrides / client / 校验 / filter（内联夹具，不依赖外部文件）
```

> `index.tsx` 因 koishi 在 vitest 下不可 import（`@koishijs/loader` 的 `require.extensions` 副作用），命令层不写单测，靠真实运行集成验证；纯逻辑（解析 / LoRA / client / 校验 / filter）全部有单测。

## 测试

```bash
npx vitest run <plugin-dir>/__tests__   # 全部
npx tsc --noEmit                         # 类型检查
```
