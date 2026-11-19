import { Context, Service } from 'koishi'

import puppeteer, { type Browser, type Page } from 'puppeteer-core'

declare module 'koishi' {
  export interface Context {
    puppeteer: PuppeteerService
  }
}

export interface PuppeteerConfig {
  /** `ws://…/?token=…` of the shared browser container (`browser/`). */
  endpoint: string
  maxPages?: number
}

/**
 * Pages from the shared browser container. Replaces koishi-plugin-puppeteer,
 * which can only `launch` a local Chrome. Callers only use `page()`.
 *
 * Every page lives in its own browser context, and closing the page disposes
 * the context: cookies never leak between jobs, and popups opened by the page
 * go away with it. The browser container also force-closes pages older than
 * 120s, so callers must finish a page within that.
 */
export default class PuppeteerService extends Service {
  private browser?: Browser
  private connecting?: Promise<Browser>
  private active = 0
  private waiters: (() => void)[] = []
  /** Slots held by open pages; released all at once when the browser goes away. */
  private holders = new Set<() => void>()
  private readonly log: ReturnType<Context['logger']>

  constructor(
    ctx: Context,
    public config: PuppeteerConfig
  ) {
    super(ctx, 'puppeteer')
    this.log = ctx.logger('puppeteer')
  }

  async start() {
    // Don't block startup on the browser: page() reconnects on demand.
    await this.connect().catch((e) => {
      this.log.warn('browser not reachable yet:', e?.message || e)
    })
  }

  async stop() {
    const browser = this.browser
    this.browser = undefined
    await browser?.disconnect().catch(() => {})
  }

  private connect(): Promise<Browser> {
    if (this.browser?.connected) return Promise.resolve(this.browser)
    this.connecting ||= puppeteer
      .connect({
        browserWSEndpoint: this.config.endpoint,
        // Same as koishi-plugin-puppeteer's default, so renders keep their size.
        defaultViewport: { width: 1280, height: 768, deviceScaleFactor: 2 },
      })
      .then((browser) => {
        this.browser = browser
        browser.once('disconnected', () => {
          if (this.browser === browser) this.browser = undefined
          for (const release of [...this.holders]) release()
          this.log.warn('browser disconnected')
        })
        this.log.info('connected to browser')
        return browser
      })
      .finally(() => {
        this.connecting = undefined
      })
    return this.connecting
  }

  async page(): Promise<Page> {
    await this.acquire()
    let released = false
    const release = () => {
      if (released) return
      released = true
      this.holders.delete(release)
      this.release()
    }
    this.holders.add(release)
    try {
      const browser = await this.connect()
      const context = await browser.createBrowserContext()
      const page = await context.newPage().catch(async (e) => {
        await context.close().catch(() => {})
        throw e
      })
      page.once('close', () => {
        release()
        context.close().catch(() => {})
      })
      return page
    } catch (e) {
      release()
      throw e
    }
  }

  private acquire(): Promise<void> {
    if (this.active < (this.config.maxPages ?? 3)) {
      this.active++
      return Promise.resolve()
    }
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private release() {
    const next = this.waiters.shift()
    if (next) next()
    else this.active--
  }
}
