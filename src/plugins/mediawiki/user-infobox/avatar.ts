import type { Context } from 'koishi'

const AVATAR_TIMEOUT = 5000
/** The data: URI rides in the page URL; Chrome rejects URLs over 2 MB. */
const AVATAR_MAX_BYTES = 1024 * 1024

/**
 * Download the avatar and inline it as a data: URI. Avatar hosts send no CORS headers,
 * so a remote <img> would taint the template's canvas and block hue sampling.
 * Returns undefined when the user has no avatar (404) or the download fails.
 */
export async function fetchAvatar(
  ctx: Context,
  url: string
): Promise<string | undefined> {
  try {
    const file = await ctx.http.file(url, { timeout: AVATAR_TIMEOUT })
    if (!file.type?.startsWith('image/')) return
    if (file.data.byteLength > AVATAR_MAX_BYTES) return
    return `data:${file.type};base64,${Buffer.from(file.data).toString('base64')}`
  } catch {
    return
  }
}
