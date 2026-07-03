import { Context, Service, h } from 'koishi'

import type { ScreenshotOptions, WaitForOptions } from 'puppeteer-core'
import type { BundledLanguage } from 'shiki'

import { type MarkdownRenderOptions, renderMarkdownDocument } from './markdown'
import { renderShikiDocument } from './shiki'

declare module 'koishi' {
  export interface Context {
    html: HTMLService
    puppeteer: import('koishi-plugin-puppeteer').default
  }
}

/**
 * Merge caller screenshot options over defaults, always binary-encoded. `quality`
 * only applies to JPEG, so it is dropped for any other format (puppeteer errors
 * otherwise). Centralizes what `rawHtml` and `shotByUrl` used to duplicate.
 */
function normalizeShotOptions(
  overrides: ScreenshotOptions | undefined,
  defaults: ScreenshotOptions
): ScreenshotOptions {
  const opts: ScreenshotOptions = {
    encoding: 'binary',
    ...defaults,
    ...overrides,
  }
  if (opts.type !== 'jpeg') delete opts.quality
  return opts
}

export default class HTMLService extends Service {
  static inject = ['puppeteer']
  readonly log: ReturnType<Context['logger']>

  constructor(public ctx: Context) {
    super(ctx, 'html')
    this.log = ctx.logger('HTML')
  }

  get ppt() {
    return this.ctx.puppeteer
  }

  // ── screenshot primitives ────────────────────────────────────────────────

  /** Screenshot an element of an inline HTML document. */
  async rawHtml(
    html: string,
    selector: string = 'body',
    shotOptions?: ScreenshotOptions
  ): Promise<Buffer | undefined> {
    const opts = normalizeShotOptions(shotOptions, {
      type: 'jpeg',
      quality: 90,
    })
    const page = await this.ppt.page()
    let file: Buffer | undefined
    try {
      await page.setContent(html, {
        waitUntil: 'networkidle0',
        timeout: 15 * 1000,
      })
      const $el = await page.$(selector)
      file = await $el?.screenshot(opts)
    } finally {
      await page?.close()
    }
    return file
  }

  /** Screenshot an element of a live URL. */
  async shotByUrl(
    url: string | URL,
    selector?: string,
    waitOptions?: WaitForOptions,
    shotOptions?: ScreenshotOptions
  ) {
    waitOptions = {
      waitUntil: 'networkidle0',
      timeout: 20 * 1000,
      ...waitOptions,
    }
    const opts = normalizeShotOptions(shotOptions, {
      type: 'jpeg',
      quality: 90,
    })

    const page = await this.ctx.puppeteer.page()

    let isInitialized = false
    page.on('load', () => {
      isInitialized = true
    })

    page.on('dialog', async (dialog) => {
      this.log.info(
        '[shotByUrl]',
        `dialog detected: ${dialog.type()}`,
        dialog.message()
      )
      await dialog.dismiss().catch((e) => {
        this.log.warn('[shotByUrl]', 'failed to dismiss dialog:', e)
      })
    })

    return page
      .goto(url.toString(), waitOptions)
      .then(async () => {
        const target = selector ? await page.$(selector) : page
        if (target) {
          return target?.screenshot(opts)
        } else {
          throw new Error(`Element not found: ${selector}`)
        }
      })
      .catch(async (e) => {
        this.log.warn(
          '[shotByUrl]',
          'Navigation timeout:',
          `(page HAS ${isInitialized ? '' : 'NOT'} loaded)`,
          e
        )
        const target = selector ? await page.$(selector) : page
        if (target) {
          this.log.warn(
            '[shotByUrl]',
            'but target found, take it anyway:',
            target,
            selector
          )
          return target?.screenshot(opts)
        } else {
          this.log.warn('[shotByUrl]', 'and no target found, throw error')
          throw e
        }
      })
      .finally(() => page.close())
  }

  // ── document wrappers ────────────────────────────────────────────────────

  /** Wrap a body fragment in a minimal HTML document, then screenshot it. */
  async html(
    body: string,
    selector: string = 'body',
    options?: ScreenshotOptions
  ) {
    const html = `<!DOCTYPE html>
<html lang="en">

<head>
  <meta charset="UTF-8">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Document</title>
  <style>
    :root {
      font-family: 'Segoe UI Emoji', 'Noto Sans SC', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
      font-size: 14px;
      color: #252525;
    }
    html, body {
      margin: 0;
      padding: 0;
    }
    * {
      box-sizing: border-box;
    }
  </style>
</head>

<body>
${body}
</body>
</html>`
    return this.rawHtml(html, selector, options)
  }

  /** Screenshot plain text as a `<pre>` block. */
  async text(text: string) {
    return this.html(`<pre>${this.escapeHtmlTags(text)}</pre>`, 'pre')
  }

  /** Screenshot a raw SVG document. */
  async svg(svg: string) {
    return this.rawHtml(svg, 'svg')
  }

  // ── code / markdown renderers ────────────────────────────────────────────

  /**
   * @deprecated Use `shiki`. Kept as a JPEG-output wrapper around `shiki` for
   * backward compatibility.
   */
  async hljs(code: string, lang = '', startFrom: number | false = 1) {
    return this.shiki(code, lang as BundledLanguage, startFrom, {
      type: 'jpeg',
      quality: 90,
    })
  }

  /** Render highlighted code (shiki, one-dark-pro) to an image. */
  async shiki(
    code: string,
    lang: BundledLanguage,
    startFrom: number | false = 1,
    shotOptions?: ScreenshotOptions
  ) {
    const html = await renderShikiDocument(code, lang, startFrom)
    return this.rawHtml(html, 'pre.shiki', {
      type: 'png',
      omitBackground: true,
      ...shotOptions,
    })
  }

  /**
   * Render Markdown (GFM) to a GitHub-styled image: satteri renders the body,
   * shiki highlights the code blocks, and the matching github-markdown-css
   * theme is inlined. Screenshots the `.markdown-body` element; defaults to a
   * PNG so text stays crisp.
   */
  async markdown(
    source: string,
    options?: MarkdownRenderOptions,
    shotOptions?: ScreenshotOptions
  ): Promise<Buffer | undefined> {
    const html = await renderMarkdownDocument(source, options)
    return this.rawHtml(html, '.markdown-body', { type: 'png', ...shotOptions })
  }

  // ── html string helpers ──────────────────────────────────────────────────

  escapeHtmlTags(text: string) {
    return text.replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  }
  propsToText(props: Record<string, string>) {
    return Object.entries(props)
      .filter(([key, value]) => typeof value !== 'undefined' && value !== null)
      .map(([key, value]) => `${key}="${this.propValueToText(value)}"`)
      .join(' ')
  }
  propValueToText(value: string) {
    return value
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .trim()
  }
}
