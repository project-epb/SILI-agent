import type { OverrideArgs, TemplateBindings } from './template-loader'

/** 已由 session.resolve 解析过的 filter 配置（Computed → 具体值）。 */
export interface ResolvedFilter {
  blacklist?: string[]
  forcePositive?: string
  forceNegative?: string
}

/**
 * 把内置 filter 应用到 args（就地修改）。命中黑名单时返回拒绝原因字符串；
 * 否则应用强制正/负面词并返回 void。
 *
 * 纯函数——Computed 由调用方（内置监听器）用 session.resolve 解析后传入，
 * 便于不依赖 koishi 单测。
 */
export function applyBuiltinFilter(
  args: OverrideArgs,
  template: TemplateBindings,
  f: ResolvedFilter
): string | void {
  const lowerPrompt = args.prompt.toLowerCase()
  for (const word of f.blacklist ?? []) {
    if (word && lowerPrompt.includes(word.toLowerCase())) {
      return `提示词命中禁止词「${word}」，此场景不允许该内容，已拒绝生成。`
    }
  }
  if (f.forcePositive) {
    args.prompt = `${args.prompt}, ${f.forcePositive}`
  }
  if (f.forceNegative) {
    // 保留模板调优的 seed_negative：在最终 negative 基底上 append，而非覆盖。
    const base = args.negative ?? template.seedNegative ?? ''
    args.negative = base ? `${base}, ${f.forceNegative}` : f.forceNegative
  }
}
