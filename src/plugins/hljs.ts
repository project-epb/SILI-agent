import { Context, h } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

/**
 * `tools/shiki`（别名 `hljs`）— 用 shiki 把代码高亮成图片。不填 `-l` 时自动
 * 检测语言（flourite），恢复了旧 hljs 的 auto 能力。`ctx.html.hljs` 已 deprecated，
 * 两个命令合并到一处，统一走 shiki。
 */
export default class PluginHljs extends BasePlugin {
  static inject = ['html']

  constructor(ctx: Context) {
    super(ctx, {}, 'shiki')

    ctx
      .command('tools/shiki <code:text>', '代码高亮')
      .alias('hljs')
      .option('lang', '-l <lang:string> 语言（不填自动检测）')
      .option('from', '-f <from:posint> 起始行号', { fallback: 1 })
      .action(async ({ session, options }, code) => {
        if (!code) return session?.execute('shiki -h')
        try {
          const img = await ctx.html.shiki(
            code,
            (options?.lang as any) || 'auto',
            options?.from
          )
          return img ? h.img(img, 'image/png') : '渲染代码时出现了一些问题。'
        } catch (e) {
          return `渲染代码时出现了一些问题：${e.message}`
        }
      })
  }
}
