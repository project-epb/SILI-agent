import { Context, h } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

const MD_SAMPLE = [
  '# Markdown 渲染测试',
  '',
  '**加粗** · *斜体* · ~~删除线~~ · `行内代码` · [链接](https://github.com)',
  '',
  '- [x] 任务完成',
  '- [ ] 待办事项',
  '',
  '| 库 | 语言 | GFM |',
  '| --- | :---: | :---: |',
  '| satteri | Rust | ✅ |',
  '| marked | JS | ✅ |',
  '',
  '> 引用块：单进程内合并并发请求。',
  '',
  '```ts',
  'const answer: number = 42',
  'console.log(`hello ${answer}`)',
  '```',
].join('\n')

/** `debug.md` / `debug.markdown` — render markdown (GFM) to an image via `ctx.html.markdown`. */
export default class DebugMarkdown extends BasePlugin {
  static inject = ['html']

  constructor(ctx: Context) {
    super(ctx, {}, 'debug-markdown')

    ctx
      .command('debug.md [source:text]', 'Render markdown to image', {
        authority: 3,
      })
      .alias('debug.markdown')
      .option('dark', '-d Use dark theme')
      .option('width', '-w <px:posint> Content width in px')
      .action(async ({ session, options }, source) => {
        const md = source?.trim() || session.quote?.content?.trim() || MD_SAMPLE
        const img = await ctx.html.markdown(md, {
          theme: options.dark ? 'dark' : 'light',
          width: options.width,
        })
        return img ? h.img(img, 'image/png') : 'Failed to render.'
      })
  }
}
