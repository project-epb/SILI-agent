import type { Context } from 'koishi'

const IMAGE_TIMEOUT = 5000
/**
 * Inlined images ride in the page URL, which Chrome caps at 2 MB. Avatar + cover
 * at this cap stays under it after base64's 4/3 inflation.
 */
const IMAGE_MAX_BYTES = 512 * 1024

/**
 * Download an image and inline it as a data: URI for the card template. Avatar hosts
 * send no CORS headers, so a remote <img> would taint the canvas used for hue sampling;
 * inlining also keeps the screenshot from waiting on the page's own network.
 * Returns undefined on 404 (e.g. no avatar set), non-image responses, oversize or failure.
 */
export async function fetchImage(
  ctx: Context,
  url: string
): Promise<string | undefined> {
  try {
    const file = await ctx.http.file(url, { timeout: IMAGE_TIMEOUT })
    if (!file.type?.startsWith('image/')) return
    if (file.data.byteLength > IMAGE_MAX_BYTES) return
    return `data:${file.type};base64,${Buffer.from(file.data).toString('base64')}`
  } catch {
    return
  }
}
