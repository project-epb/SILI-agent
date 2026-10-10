import type { MediaWikiApi } from 'wiki-saikou/node'

/** Below this short side it's an icon / userbox badge, not artwork. */
const COVER_MIN_SIDE = 300
/** Banner is 360 CSS px at DPR 2. */
const COVER_THUMB_WIDTH = 720
/** Non-bot API cap on titles per query. */
const MAX_FILES = 50

interface ImageInfoQuery {
  normalized?: { from: string; to: string }[]
  pages: {
    title: string
    imageinfo?: {
      mime: string
      width: number
      height: number
      url: string
      thumburl?: string
    }[]
  }[]
}

/**
 * First qualifying raster image in page order. Size is the only signal — a large
 * logo still passes, which is acceptable for an ambient banner.
 */
export function selectCover(
  files: string[],
  query: ImageInfoQuery
): string | undefined {
  const normalized = new Map(query.normalized?.map((n) => [n.from, n.to]))
  const infoByTitle = new Map(
    query.pages.map((p) => [p.title, p.imageinfo?.[0]])
  )
  for (const file of files) {
    const raw = `File:${file}`
    const title = normalized.get(raw) ?? raw.replace(/_/g, ' ')
    const info = infoByTitle.get(title)
    if (
      info &&
      info.mime !== 'image/svg+xml' &&
      Math.min(info.width, info.height) >= COVER_MIN_SIDE
    ) {
      return info.thumburl ?? info.url
    }
  }
}

/**
 * Thumbnail URL of the first artwork on a user page, or undefined when there is none
 * (including a missing user page, which `parse` rejects).
 */
export async function findCoverUrl(
  api: MediaWikiApi,
  title: string
): Promise<string | undefined> {
  try {
    const { data: parsed } = await api.get<{ parse?: { images?: string[] } }>({
      action: 'parse',
      page: title,
      prop: 'images',
    })
    // parse lists images in page order; prop=images on a query would sort them by name
    const files = parsed?.parse?.images?.slice(0, MAX_FILES) ?? []
    if (!files.length) return

    const { data } = await api.get<{ query?: ImageInfoQuery }>({
      action: 'query',
      titles: files.map((f) => `File:${f}`),
      prop: 'imageinfo',
      iiprop: 'url|size|mime',
      iiurlwidth: COVER_THUMB_WIDTH,
    })
    return data?.query ? selectCover(files, data.query) : undefined
  } catch {
    return
  }
}
