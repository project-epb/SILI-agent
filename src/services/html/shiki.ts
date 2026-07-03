import type { BundledLanguage } from 'shiki'

import { detectLang } from './detect-lang'
import { MONO_FONT } from './fonts'

/**
 * Render a code snippet to a complete, self-contained HTML document with shiki
 * syntax highlighting (one-dark-pro theme), a language badge, and optional line
 * numbers. Meant to be screenshotted at its `pre.shiki` element.
 *
 * Throws if `lang` is a non-empty language shiki does not bundle; an empty lang
 * renders as plain (unhighlighted) text.
 *
 * Pure and browser-free, so it is unit testable on its own.
 */
export async function renderShikiDocument(
  code: string,
  lang: BundledLanguage,
  startFrom: number | false = 1
): Promise<string> {
  const { bundledLanguages, bundledLanguagesInfo, codeToHtml } =
    await import('shiki')

  // `auto` (or empty) triggers detection — restoring the auto-language behaviour
  // hljs had natively. An explicitly named but unsupported language still throws.
  if ((lang as any) === 'auto' || !lang) {
    const guessed = detectLang(code)
    lang = (guessed in bundledLanguages ? guessed : 'text') as BundledLanguage
  } else if (!(lang in bundledLanguages)) {
    throw new Error(`Language not supported: ${lang}`)
  }

  const langInfo = bundledLanguagesInfo.find(
    (i) => i.aliases?.includes(lang) || i.id === lang || i.name === lang
  )
  const langLabel = (() => {
    // No badge for plain text (undetected / unlabelled) — the label would just say "text".
    const l = lang as string
    if (!l || l === 'text' || l === 'plaintext') return ''
    if (!langInfo) return lang
    return [langInfo.aliases?.[0], langInfo.name, langInfo.id, lang]
      .filter(Boolean)
      .sort((a, b) => a.length - b.length)[0]
  })()

  const highlighted = await codeToHtml(code, {
    lang,
    theme: 'one-dark-pro',
    transformers: [
      {
        pre(node) {
          node.properties.style += ';'
          node.properties.style += `padding-right: ${(10 * langLabel.length + 12).toFixed()}px;`
          if (typeof startFrom === 'number') {
            node.properties.class += ' line-number'
          }
        },
        code(node) {
          node.properties.style += `;--start: ${startFrom};`
        },
        line(hast, line) {
          hast.properties['data-node-line-number'] = line
        },
        postprocess(html) {
          if (langLabel) {
            return html.replace(
              '</pre>',
              `<code class="lang-badge">${langLabel}</code></pre>`
            )
          }
        },
      },
    ],
  })

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
html, body { margin: 0; padding: 0; }
* { box-sizing: border-box; }
pre.shiki {
  position: relative;
  font-family: ${MONO_FONT};
  font-size: 16px;
  display: inline-block;
  padding: 1em;
  border-radius: 0.5em;
  white-space: pre;
}
pre.shiki > .lang-badge {
  position: absolute;
  right: 0.5em;
  top: 0.5em;
  font-size: 10px;
  border-radius: 99vw;
  background: #000;
  padding: 0.2em 0.5em;
}
pre.shiki.line-number code {
  counter-reset: step;
  counter-increment: step calc(var(--start, 1) - 1);
}
pre.shiki.line-number code .line::before {
  content: counter(step);
  counter-increment: step;
  width: 1em;
  margin-right: 1em;
  display: inline-block;
  text-align: right;
  color: rgba(115, 138, 148, 0.4);
}
</style>
</head>
<body>
${highlighted}
</body>
</html>`
}
