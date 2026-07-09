import { Context, h } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

/** `tools/md` — render a Markdown (GFM) snippet to an image via `ctx.html.markdown`. */
export default class PluginMarkdown extends BasePlugin {
  static inject = ['html']

  constructor(ctx: Context) {
    super(ctx, {}, 'markdown')

    ctx
      .command('tools/md <source:text>', '渲染 Markdown 为图片')
      .alias('tools/markdown')
      .option('dark', '-d 暗色主题')
      .option('width', '-w <px:posint> 内容宽度（px）')
      .action(async ({ session, options }, source) => {
        const md = source?.trim() || session?.quote?.content?.trim()
        if (!md) return session?.execute('md -h')
        const img = await ctx.html.markdown(md, {
          theme: options?.dark ? 'dark' : 'light',
          width: options?.width,
        })
        return img
          ? h.img(img, 'image/png')
          : '渲染 Markdown 时出现了一些问题。'
      })
  }
}
