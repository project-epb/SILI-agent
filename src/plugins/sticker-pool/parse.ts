/**
 * Pure helpers over the message content QQ (official bot) delivers.
 *
 * An image arrives as `<img src="https://multimedia.nt.qq.com.cn/download?...&fileid=…"/>`.
 * When it was sent *as a sticker*, QQ prefixes it with an escaped marker
 * `&lt;faceType=6,faceId="0",ext="…"&gt;`. Built-in QQ faces arrive as the
 * same kind of marker with another faceType and a base64 JSON `ext` holding
 * the face name, e.g. `{"text":"知识增加"}`.
 */

/** Marker optionally followed by an image, or an image alone. */
const ITEM =
  /(?:&lt;faceType=(\d+),faceId="(\d+)"(?:,ext="([^"]*)")?&gt;)?(<img\b[^>]*?\bsrc="([^"]*)"[^>]*>)?/g

export interface InboundImage {
  /** Full matched source, marker included. */
  raw: string
  url: string
  sha1?: string
  /** QQ marked it as sent-as-sticker (faceType=6). */
  stickerFlag: boolean
}

/**
 * The SHA1 of a QQ NT image, read from its download URL without downloading.
 * `fileid` is base64url protobuf; field 2 (`0x12`) with length 20 (`0x14`)
 * holds the file's SHA1 — verified against downloaded originals.
 */
export function sha1FromQQImageUrl(url: string): string | undefined {
  const m = /[?&]fileid=([^&"]+)/.exec(url.replace(/&amp;/g, '&'))
  if (!m) return
  let bytes: Buffer
  try {
    bytes = Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  } catch {
    return
  }
  if (bytes.length < 22 || bytes[0] !== 0x12 || bytes[1] !== 0x14) return
  return bytes.subarray(2, 22).toString('hex')
}

/** Name carried in a QQ face marker's `ext` (base64 JSON `{"text": …}`). */
export function faceNameFromExt(ext: string | undefined): string {
  if (!ext) return ''
  try {
    const json = JSON.parse(Buffer.from(ext, 'base64').toString('utf8'))
    return typeof json?.text === 'string' ? json.text.replace(/^\//, '') : ''
  } catch {
    return ''
  }
}

export function scanImages(content: string): InboundImage[] {
  const out: InboundImage[] = []
  for (const m of content.matchAll(ITEM)) {
    if (!m[4]) continue
    const url = m[5].replace(/&amp;/g, '&')
    out.push({
      raw: m[0],
      url,
      sha1: sha1FromQQImageUrl(url),
      stickerFlag: m[1] === '6',
    })
  }
  return out
}

export interface StickerLabel {
  id: number
  desc: string
  usage: string
}

const attr = (s: string) => s.replace(/["\]]/g, '')

export function stickerPlaceholder(s: StickerLabel): string {
  const usage = s.usage ? ` 用法="${attr(s.usage)}"` : ''
  return `[表情包 id="${s.id}" alt="${attr(s.desc)}"${usage}]`
}

/**
 * Rewrite content for the model: known stickers become `[表情包 …]`, unknown
 * sticker-flagged images become `[表情包]`, QQ faces become `[QQ表情:名称]`.
 * Plain images that are not in the pool stay untouched.
 */
export function rewriteInbound(
  content: string,
  lookup: (sha1: string) => StickerLabel | undefined
): string {
  if (!content.includes('&lt;faceType=') && !content.includes('<img'))
    return content
  return content.replace(ITEM, (raw, faceType, _faceId, ext, img, src) => {
    if (!raw) return raw
    if (img) {
      const sha1 = sha1FromQQImageUrl(src)
      const known = sha1 ? lookup(sha1) : undefined
      if (known) return stickerPlaceholder(known)
      if (faceType === '6') return '[表情包]'
      // a non-sticker marker glued to an image: keep the image, render the face
      return faceType ? `${facePlaceholder(ext)}${img}` : img
    }
    return facePlaceholder(ext)
  })
}

function facePlaceholder(ext: string | undefined) {
  const name = faceNameFromExt(ext)
  return name ? `[QQ表情:${name}]` : '[QQ表情]'
}
