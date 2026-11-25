import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/** What the model sees of a stored image; `id` is the sha256's first 12 hex. */
export interface ImageRef {
  id: string
  sha256: string
  type: string
  width: number
  height: number
}

export interface EncodedImage {
  bytes: Uint8Array
  width: number
  height: number
}

/** Downscale + re-encode raw image bytes (see image-encode.ts). */
export type ImageEncoder = (bytes: Uint8Array) => Promise<EncodedImage>

export interface ImageStoreOptions {
  dir: string
  /** Delete images unused this long (by mtime). */
  ttlMs: number
  /** Total size cap; least recently used go first. */
  maxBytes: number
  /** Refuse source images larger than this. */
  maxImageBytes: number
  encode: ImageEncoder
  /** Fetch a URL's bytes (koishi's ctx.http.file in production). */
  fetch: (url: string) => Promise<Uint8Array>
}

const TYPE = 'image/webp'
// <sha256>.<w>x<h>.webp — the name carries everything a tag needs, so the
// index rebuilds from readdir alone.
const NAME = /^([0-9a-f]{64})\.(\d+)x(\d+)\.webp$/

export const IMAGE_ID_LENGTH = 12

/**
 * Content-addressed store for images the model looks at, on the host (not
 * the Linux VM). Keyed by the sha256 of the source bytes, so a re-sent
 * picture is one file. mtime is the LRU clock: every use touches it;
 * cleanup drops files idle past the TTL, then the least recently used
 * until under the size cap.
 */
export class ImageStore {
  private index: Map<string, ImageRef> | null = null
  private loading: Promise<Map<string, ImageRef>> | null = null
  /** Source URL → ref, so re-reading chat history does not re-download. */
  private byUrl = new Map<string, ImageRef>()

  constructor(private readonly opts: ImageStoreOptions) {}

  private fileOf(ref: ImageRef) {
    return path.join(this.opts.dir, `${ref.sha256}.${ref.width}x${ref.height}.webp`)
  }

  private async loadIndex(): Promise<Map<string, ImageRef>> {
    if (this.index) return this.index
    this.loading ??= (async () => {
      await fs.mkdir(this.opts.dir, { recursive: true })
      const index = new Map<string, ImageRef>()
      for (const name of await fs.readdir(this.opts.dir)) {
        const m = NAME.exec(name)
        if (!m) continue
        const ref = { id: m[1].slice(0, IMAGE_ID_LENGTH), sha256: m[1], type: TYPE, width: +m[2], height: +m[3] }
        index.set(ref.id, ref)
      }
      this.index = index
      return index
    })()
    return this.loading
  }

  /** Store raw image bytes; returns the existing ref when already stored. */
  async put(bytes: Uint8Array): Promise<ImageRef> {
    if (bytes.length > this.opts.maxImageBytes)
      throw new Error(`image over ${this.opts.maxImageBytes} bytes`)
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
    const index = await this.loadIndex()
    const id = sha256.slice(0, IMAGE_ID_LENGTH)
    const known = index.get(id)
    if (known?.sha256 === sha256) {
      await this.touch(known)
      return known
    }
    const encoded = await this.opts.encode(bytes)
    const ref = { id, sha256, type: TYPE, width: encoded.width, height: encoded.height }
    const file = this.fileOf(ref)
    await fs.writeFile(`${file}.part`, encoded.bytes)
    await fs.rename(`${file}.part`, file)
    index.set(id, ref)
    return ref
  }

  /** Download and store an image; the same URL is fetched once per process. */
  async fetch(url: string): Promise<ImageRef> {
    const cached = this.byUrl.get(url)
    if (cached && (await this.get(cached.id))) return cached
    const ref = await this.put(await this.opts.fetch(url))
    this.byUrl.set(url, ref)
    if (this.byUrl.size > 2000) this.byUrl.delete(this.byUrl.keys().next().value!)
    return ref
  }

  /** The ref for an id, or undefined once evicted. */
  async get(id: string): Promise<ImageRef | undefined> {
    return (await this.loadIndex()).get(id)
  }

  /** The stored WebP bytes, touching the LRU clock; undefined once evicted. */
  async read(id: string): Promise<{ ref: ImageRef; bytes: Uint8Array; type: string } | undefined> {
    const ref = await this.get(id)
    if (!ref) return
    try {
      const bytes = new Uint8Array(await fs.readFile(this.fileOf(ref)))
      await this.touch(ref)
      return { ref, bytes, type: ref.type }
    } catch {
      this.index?.delete(id)
      return
    }
  }

  private async touch(ref: ImageRef) {
    const now = new Date()
    await fs.utimes(this.fileOf(ref), now, now).catch(() => {})
  }

  async cleanup(now = Date.now()): Promise<{ removed: number; kept: number; totalBytes: number }> {
    const index = await this.loadIndex()
    const entries: { ref: ImageRef; file: string; mtime: number; size: number }[] = []
    for (const ref of index.values()) {
      const file = this.fileOf(ref)
      const st = await fs.stat(file).catch(() => undefined)
      if (!st) {
        index.delete(ref.id)
        continue
      }
      entries.push({ ref, file, mtime: st.mtimeMs, size: st.size })
    }
    entries.sort((a, b) => a.mtime - b.mtime)
    let total = entries.reduce((s, e) => s + e.size, 0)
    let removed = 0
    for (const e of entries) {
      if (now - e.mtime <= this.opts.ttlMs && total <= this.opts.maxBytes) break
      await fs.unlink(e.file).catch(() => {})
      index.delete(e.ref.id)
      total -= e.size
      removed++
    }
    return { removed, kept: entries.length - removed, totalBytes: total }
  }
}

/** The tag the model sees in place of an image. */
export function imageTag(ref: ImageRef): string {
  return `<image id="${ref.id}" type="${ref.type}" width="${ref.width}" height="${ref.height}"/>`
}

const TAG = /<image id="([0-9a-f]{12})"[^>]*\/>/g

/** Image ids in the order their tags appear. */
export function imageIdsIn(text: string): string[] {
  return [...text.matchAll(TAG)].map((m) => m[1])
}

export const MAX_IMAGES_PER_MESSAGE = 4

/**
 * Which images of one message get their pixels sent: the first few. The
 * note (empty when all fit) is persisted with the message, so a replay
 * attaches the same ones.
 */
export function attachedImages(envelope: string): { ids: string[]; note: string } {
  const all = [...new Set(imageIdsIn(envelope))]
  const ids = all.slice(0, MAX_IMAGES_PER_MESSAGE)
  const note =
    all.length > ids.length
      ? `（这条消息共 ${all.length} 张图，只附了前 ${ids.length} 张，其余可用 view_image 查看）`
      : ''
  return { ids, note }
}
