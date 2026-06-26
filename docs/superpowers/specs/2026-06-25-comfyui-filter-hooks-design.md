# ComfyUI 提示词限制/改写扩展点 设计

让 SILI 能对 `comfyui.generate` 的入参做限制与改写——既支持复杂/可扩展逻辑（event 钩子），也支持开箱即用的常见场景（声明式配置，按群生效）。典型用例：某些群禁 nsfw、强制注入负面词防擦边。

## 两层设计

### ① event：`comfyui/before-generate`（核心机制）

- **时机**：`#handleGenerate` 里参数校验 + LoRA 校验**之后**、`applyOverrides` **之前**——监听器改的是最终入参。
- **payload**：`{ session: Session; template: TemplateBindings; args: OverrideArgs }`，`args` 可变；监听器就地改 `args.prompt` / `args.negative` / `args.steps` 等。
- **emit**：`await ctx.serial('comfyui/before-generate', payload)` —— async serial，按注册顺序 await 每个监听器；任一监听器返回**非空字符串 = 拒绝**（bail，该串作为原因），或**抛错**也视为拒绝。返回 `void` 则继续。
- **类型**：
  ```ts
  declare module 'koishi' {
    interface Events {
      'comfyui/before-generate'(payload: ComfyuiBeforeGenerate): Awaitable<string | void>
    }
  }
  ```
- 第三方可 `ctx.on('comfyui/before-generate', async ({ session, args }) => { ... })` 接入任意审核（正则、外部 API、按群、查 DB）。

### ② 内置 filter 配置（声明式便利层）

```ts
filter?: {
  blacklist?: Computed<string[]>     // prompt 命中任一词 → 拒绝生成
  forcePositive?: Computed<string>   // 强制 append 进 prompt
  forceNegative?: Computed<string>   // 强制 append 进 negative
}
```

- `Computed<T> = T | ((session) => T)` → 用 `session.resolve(computed)` 解析，可 `(session) => session.channelId === X ? ['nsfw'] : []` 按群/按人生效。
- 插件构造时注册一个**内置监听器** `ctx.on('comfyui/before-generate', …)`，解析 config 后调用纯函数 `applyBuiltinFilter` 应用：
  - blacklist：`args.prompt`（小写）命中任一词 → 返回拒绝原因（bail）。
  - forcePositive：`args.prompt = \`${args.prompt}, ${fp}\``。
  - forceNegative：**保留模板默认**——`base = args.negative ?? template.seedNegative ?? ''`，再 `args.negative = base ? \`${base}, ${fn}\` : fn`。（否则直接覆盖会丢模板调优的 seed_negative。）

## 文件

- **Create** `src/plugins/comfy-ui/filter.ts`：纯函数 `applyBuiltinFilter(args, template, resolved): string | void` + `ResolvedFilter` 类型。可单测，不依赖 koishi。
- **Modify** `src/plugins/comfy-ui/index.tsx`：`declare module` 扩展 Events；Config 加 `filter`；构造时注册内置监听器（`session.resolve` 解析 Computed → `applyBuiltinFilter`）；`#handleGenerate` 在 applyOverrides 前 `await ctx.serial(...)` 并处理拒绝（返回原因给 agent）。
- **Create** `src/plugins/comfy-ui/__tests__/filter.test.ts`：`applyBuiltinFilter` 各分支（blacklist 命中拒绝/大小写不敏感、forcePositive append、forceNegative 保留模板默认 + append、空配置 no-op）。
- **Modify** `src/index.ts`：`filter` 留配置入口（默认不配；注释示例「按群禁词」），用户后续按需填。
- 文档：README + 交付说明追加「扩展点」。

## 拒绝路径

`#handleGenerate` 收到 `ctx.serial` 的非空返回（或捕获监听器抛错）→ 不调 client、直接返回该原因字符串给 agent（agent 转告用户）。与现有 `COMFYUI_DENY_MSG`（频道白名单）一致：拒绝即不画、回明确原因。

## 不做（YAGNI）

- 不做 `stripWords`（命中移除）——blacklist 选定「命中即拒绝」语义；需要清洗/改写的复杂逻辑走 event 监听器自己写。
- 不做 `after-generate` 事件（本版只要前置过滤）。
