import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Page } from 'puppeteer-core'

/**
 * Local HTML templates (stickers, user-infobox) are `file:` URLs under `src/`,
 * but the browser lives in its own container and cannot read core's disk. They
 * are rewritten to this origin, and requests to it are answered by core over
 * CDP. `.invalid` never resolves, so nothing leaks to the network if
 * interception is missing.
 */
export const LOCAL_ORIGIN = 'http://sili-local.invalid'

/** Only files under `src/` are served. */
export const LOCAL_ROOT = resolve(import.meta.dirname, '../..')

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

/** `file:` URL under `src/` → the same path on LOCAL_ORIGIN; anything else → null. */
export function toLocalOriginUrl(url: string | URL): URL | null {
  const parsed = new URL(url.toString())
  if (parsed.protocol !== 'file:') return null
  const file = fileURLToPath(parsed)
  if (!file.startsWith(LOCAL_ROOT + sep)) {
    throw new Error(`local file outside ${LOCAL_ROOT}: ${file}`)
  }
  const mapped = new URL(LOCAL_ORIGIN)
  mapped.pathname = file
    .slice(LOCAL_ROOT.length)
    .split(sep)
    .map(encodeURIComponent)
    .join('/')
  mapped.search = parsed.search
  mapped.hash = parsed.hash
  return mapped
}

/** LOCAL_ORIGIN request path → absolute file path, or null when it escapes `src/`. */
export function resolveLocalPath(requestUrl: string): string | null {
  const pathname = decodeURIComponent(new URL(requestUrl).pathname)
  const file = resolve(LOCAL_ROOT, '.' + pathname)
  return file.startsWith(LOCAL_ROOT + sep) ? file : null
}

/** Answer this page's LOCAL_ORIGIN requests from disk; other requests are untouched. */
export async function serveLocalFiles(page: Page) {
  const client = await page.createCDPSession()
  client.on('Fetch.requestPaused', async ({ requestId, request }) => {
    const respond = (responseCode: number, body: Buffer, type?: string) =>
      client
        .send('Fetch.fulfillRequest', {
          requestId,
          responseCode,
          responseHeaders: type ? [{ name: 'Content-Type', value: type }] : [],
          body: body.toString('base64'),
        })
        .catch(() => {})
    const file = resolveLocalPath(request.url)
    if (!file) return respond(403, Buffer.alloc(0))
    try {
      const body = await readFile(file)
      return respond(200, body, CONTENT_TYPES[extname(file).toLowerCase()])
    } catch {
      return respond(404, Buffer.alloc(0))
    }
  })
  await client.send('Fetch.enable', {
    patterns: [{ urlPattern: `${LOCAL_ORIGIN}/*` }],
  })
}
