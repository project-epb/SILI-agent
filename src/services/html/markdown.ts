import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { defineHastPlugin, markdownToHtml } from 'satteri'

import { detectLang } from './detect-lang'
import { MONO_FONT } from './fonts'

const require = createRequire(import.meta.url)

export type MarkdownTheme = 'light' | 'dark'

export interface MarkdownRenderOptions {
  /** GitHub color theme. Default `'light'`. */
  theme?: MarkdownTheme
  /** Content width in px — the `.markdown-body` box width. Default `768`. */
  width?: number
}

/** GitHub code-block chrome colours, keyed by theme (matches GitHub's own). */
const CODE_BG: Record<MarkdownTheme, string> = {
  light: '#f6f8fa',
  dark: '#161b22',
}

/** github-markdown-css content, read from disk once per theme. */
const cssCache = new Map<MarkdownTheme, string>()
function githubMarkdownCss(theme: MarkdownTheme): string {
  let css = cssCache.get(theme)
  if (!css) {
    const file = `github-markdown-css/github-markdown-${theme}.css`
    css = readFileSync(require.resolve(file), 'utf8')
    cssCache.set(theme, css)
  }
  return css
}

/** Pull the `xx` out of a hast code node's `language-xx` className, if any. */
function extractLang(className: unknown): string | undefined {
  if (!Array.isArray(className)) return undefined
  for (const c of className) {
    if (typeof c === 'string' && c.startsWith('language-')) return c.slice(9)
  }
  return undefined
}

/**
 * Render Markdown to a complete, self-contained HTML document styled to look
 * like GitHub — GFM via satteri, code blocks highlighted by shiki, and the
 * matching github-markdown-css theme inlined. The document is meant to be
 * screenshotted at its `.markdown-body` element.
 *
 * Code highlighting hooks satteri's hast pipeline directly: a `pre` visitor
 * hands the raw code text to shiki's `codeToHast` and swaps the node for the
 * highlighted tree — no HTML string munging or entity round-tripping. Unknown
 * or missing languages fall back to `text` (shiki renders them unhighlighted
 * rather than throwing).
 *
 * The CSS read is cached but otherwise this is pure, so it is unit testable
 * without a browser.
 */
export async function renderMarkdownDocument(
  source: string,
  options: MarkdownRenderOptions = {}
): Promise<string> {
  const theme: MarkdownTheme = options.theme === 'dark' ? 'dark' : 'light'
  const width = options.width ?? 768
  const shikiTheme = theme === 'dark' ? 'github-dark' : 'github-light'

  const { codeToHast, bundledLanguages } = await import('shiki')

  const highlightCodeBlocks = defineHastPlugin({
    name: 'shiki-code-blocks',
    element: {
      filter: ['pre'],
      async visit(node, ctx) {
        const code = node.children.find(
          (c) => c.type === 'element' && c.tagName === 'code'
        )
        if (!code || code.type !== 'element') return // not a fenced code block

        const text = ctx.textContent(node).replace(/\n$/, '')
        // Declared language wins; fall back to detecting an unlabelled fence.
        const guessed =
          extractLang(code.properties?.className) || detectLang(text)
        const validLang = guessed in bundledLanguages ? guessed : 'text'

        const root = await codeToHast(text, {
          lang: validLang,
          theme: shikiTheme,
        })
        const pre = root.children[0]
        if (pre) ctx.replaceNode(node, pre as any)
      },
    },
  })

  const { html: body } = await markdownToHtml(source, {
    hastPlugins: [highlightCodeBlocks],
  })
  const css = githubMarkdownCss(theme)

  return `<!DOCTYPE html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
${css}
:root { color-scheme: ${theme}; }
html, body { margin: 0; padding: 0; }
body { display: inline-block; }
.markdown-body {
  box-sizing: border-box;
  width: ${width}px;
  max-width: 100%;
  padding: 24px 28px;
}
/* Force a real monospace stack — the page's CJK sans default isn't fixed-width. */
.markdown-body code,
.markdown-body kbd,
.markdown-body pre,
.markdown-body pre.shiki,
.markdown-body pre.shiki code,
.markdown-body pre.shiki span {
  font-family: ${MONO_FONT};
}
/* Let shiki own the code text colours, but give the block GitHub's chrome:
   its inline background-color is overridden so lang-less and highlighted
   fences share one look. */
.markdown-body pre.shiki {
  padding: 16px;
  border-radius: 6px;
  overflow: auto;
  background: ${CODE_BG[theme]} !important;
}
.markdown-body pre.shiki code { background: transparent; }
</style>
</head>
<body>
<article class="markdown-body">
${body}
</article>
</body>
</html>`
}
