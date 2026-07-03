import { describe, expect, it } from 'vitest'

import { renderShikiDocument } from '../shiki'

describe('renderShikiDocument', () => {
  it('渲染 shiki 高亮文档（pre.shiki + 等宽字体 + 高亮 span）', async () => {
    const html = await renderShikiDocument('const x = 1', 'ts')
    expect(html).toContain('class="shiki')
    expect(html).toContain('JetBrains Mono')
    expect(html).toContain('<span')
  })

  it('带语言角标', async () => {
    const html = await renderShikiDocument('const x = 1', 'ts')
    // the badge element, not the `.lang-badge` CSS selector that is always present
    expect(html).toContain('<code class="lang-badge">')
  })

  it('检测不出语言（text）时不渲染语言角标', async () => {
    const html = await renderShikiDocument('{ }', 'auto' as any)
    expect(html).not.toContain('<code class="lang-badge">')
  })

  it('startFrom 为数字时给 pre 加行号 class', async () => {
    const html = await renderShikiDocument('a\nb', 'ts', 5)
    expect(html).toMatch(/<pre class="[^"]*line-number/)
  })

  it('未知语言抛错', async () => {
    await expect(
      renderShikiDocument('x', 'no-such-lang-xyz' as any)
    ).rejects.toThrow(/not supported/i)
  })

  it('auto / 空语言自动检测语言，不抛错', async () => {
    const html = await renderShikiDocument(
      'const x: number = 1\ninterface I {}',
      'auto' as any
    )
    expect(html).toContain('class="shiki')
  })
})
