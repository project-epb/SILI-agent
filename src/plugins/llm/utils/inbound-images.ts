import type { Logger } from 'koishi'

import { type ImageRef, imageIdsIn, imageTag } from '../services/image-store'

const IMG = /<img\b[^>]*?\bsrc="([^"]*)"[^>]*>/g

export const IMAGE_UNAVAILABLE_TAG = '<image unavailable="图片没能下载"/>'

/**
 * Replace each `<img src=…>` in message content with an `<image id=…/>`
 * tag, downloading and storing the image. One that fails to download
 * becomes a tag saying so. Stickers the sticker pool knows are already
 * names by now and stay untouched.
 */
export async function rewriteInboundImages(
  content: string,
  fetch: (url: string) => Promise<ImageRef>,
  logger?: Logger
): Promise<string> {
  if (!content || !content.includes('<img')) return content
  const urls = [...content.matchAll(IMG)].map((m) => m[1].replace(/&amp;/g, '&'))
  const refs = new Map<string, ImageRef | null>()
  // A few at a time: a manga dump is up to 30 images.
  for (let i = 0; i < urls.length; i += 4) {
    await Promise.all(
      urls.slice(i, i + 4).map(async (url) => {
        if (refs.has(url)) return
        refs.set(url, null)
        try {
          refs.set(url, await fetch(url))
        } catch (e) {
          logger?.warn('[images] fetch failed: %s', (e as Error)?.message ?? e)
        }
      })
    )
  }
  return content.replace(IMG, (_all, src: string) => {
    const ref = refs.get(src.replace(/&amp;/g, '&'))
    return ref ? imageTag(ref) : IMAGE_UNAVAILABLE_TAG
  })
}

const TURN_IMAGES_KEY = 'images'

interface TurnImages {
  /**
   * Image ids and image URLs the model has seen in this conversation;
   * view_image accepts only these, so it never fetches an arbitrary URL.
   */
  known: Set<string>
  /** Images view_image attached this turn. */
  viewed: number
}

export function turnImages(turnState: Record<string, unknown>): TurnImages {
  let state = turnState[TURN_IMAGES_KEY] as TurnImages | undefined
  if (!state) turnState[TURN_IMAGES_KEY] = state = { known: new Set(), viewed: 0 }
  return state
}

/** Record the image ids and `<img src>` URLs in text as seen in this conversation. */
export function noteImageIds(turnState: Record<string, unknown>, text: string) {
  const { known } = turnImages(turnState)
  for (const id of imageIdsIn(text)) known.add(id)
  // Tool results arrive JSON-encoded: `<img src=\"…\"/>`.
  for (const m of text.matchAll(/<img\b[^>]*?\bsrc=\\?"([^"\\]*)\\?"/g))
    if (/^https?:/.test(m[1])) known.add(decodeUrl(m[1]))
}

/** The URL as fetched: entity- and JSON-escape-free. */
export function decodeUrl(url: string): string {
  return url.replace(/\\u0026/g, '&').replace(/&amp;/g, '&')
}
