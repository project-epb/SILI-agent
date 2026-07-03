import { describe, expect, it } from 'vitest'

import { renderMarkdownDocument } from '../markdown'

const GFM = [
  '# 标题',
  '',
  '正文含 **加粗**、~~删除线~~ 和 `行内代码`。',
  '',
  '- [x] 已完成',
  '- [ ] 待办',
  '',
  '```ts',
  'const x: number = 1',
  '```',
  '',
  '| a | b |',
  '| --- | :---: |',
  '| 1 | 2 |',
].join('\n')

describe('renderMarkdownDocument', () => {
  it('渲染 GFM：表格 / 任务列表 / 删除线', async () => {
    const html = await renderMarkdownDocument(GFM)
    expect(html).toContain('<table>')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('<del>')
  })

  it('包进 .markdown-body 容器', async () => {
    const html = await renderMarkdownDocument(GFM)
    expect(html).toContain('<article class="markdown-body">')
  })

  it('代码块交给 shiki 高亮（替换掉裸 language- 块）', async () => {
    const html = await renderMarkdownDocument(GFM)
    expect(html).toContain('class="shiki')
    expect(html).not.toContain('<code class="language-ts">')
  })

  it('无语言的围栏代码块也走 shiki，不抛错', async () => {
    const html = await renderMarkdownDocument('```\nplain fence\n```')
    expect(html).toContain('class="shiki')
    expect(html).toContain('plain fence')
  })

  it('未知语言降级为纯文本，不抛错', async () => {
    const html = await renderMarkdownDocument('```no-such-lang-xyz\nfoo\n```')
    expect(html).toContain('class="shiki')
    expect(html).toContain('foo')
  })

  it('代码里的 < 走 hast 只转义一次（不双重转义）', async () => {
    const html = await renderMarkdownDocument(
      '```ts\ntype T = Array<number>\n```'
    )
    // The pre visitor feeds shiki the raw hast text, so `<` is encoded exactly
    // once when satteri serializes the tree. A `&amp;lt;` would mean the code
    // was double-escaped (the old string-munging failure mode).
    expect(html).not.toContain('&amp;lt;')
    expect(html).toContain('&lt;')
  })

  it('theme=light 注入 light 主题 css', async () => {
    const html = await renderMarkdownDocument(GFM, { theme: 'light' })
    expect(html).not.toContain('#0d1117') // dark canvas colour
    expect(html).toContain('#f6f8fa') // light code-block chrome
  })

  it('theme=dark 注入 dark 主题 css', async () => {
    const html = await renderMarkdownDocument(GFM, { theme: 'dark' })
    expect(html).toContain('#0d1117') // dark canvas colour, dark css only
    expect(html).toContain('#161b22') // dark code-block chrome
  })

  it('代码用等宽字体预设（CJK sans 非等宽）', async () => {
    const html = await renderMarkdownDocument(GFM)
    expect(html).toContain('JetBrains Mono')
  })

  it('width 反映在 .markdown-body 宽度上', async () => {
    const html = await renderMarkdownDocument(GFM, { width: 900 })
    expect(html).toContain('width: 900px')
  })

  it('默认 width 768、默认 light 主题', async () => {
    const html = await renderMarkdownDocument(GFM)
    expect(html).toContain('width: 768px')
    expect(html).toContain('data-theme="light"')
  })
})
