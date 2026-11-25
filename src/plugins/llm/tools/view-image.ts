import type { ToolDefinition } from '../providers/_base'
import { imageTag } from '../services/image-store'
import { decodeUrl, turnImages } from '../utils/inbound-images'
import type { ToolHandler, ToolResult } from './types'

/** Images attached per tool batch, however many view_image calls it holds. */
export const VIEW_IMAGES_PER_BATCH = 4
export const VIEW_IMAGES_PER_TURN = 8

export const VIEW_IMAGE_TOOL: ToolDefinition = {
  name: 'view_image',
  description: `查看图片。images 每项是 \`<image id="…"/>\` 的 id，或 \`<img src="…"/>\` 的 URL（原样复制）。同一批调用合计最多附 ${VIEW_IMAGES_PER_BATCH} 张，每轮最多 ${VIEW_IMAGES_PER_TURN} 张。`,
  parameters: {
    type: 'object',
    properties: {
      images: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: VIEW_IMAGES_PER_BATCH,
      },
    },
    required: ['images'],
    additionalProperties: false,
  },
}

const EXPIRED = 'expired: the image can no longer be downloaded'

export const viewImageHandler: ToolHandler = {
  definition: VIEW_IMAGE_TOOL,
  async execute(args, { ctx, turnState, logger, iteration = 0 }): Promise<ToolResult> {
    const wanted = [
      ...new Set(
        (Array.isArray(args?.images) ? args.images : [])
          .map((s: unknown) => String(s).trim())
          .map((s: string) => (/^https?:/.test(s) ? decodeUrl(s) : s))
      ),
    ] as string[]
    if (!wanted.length) return { content: 'Error: images is empty.' }
    const state = turnImages(turnState)
    const unknown = wanted.filter((s) => !state.known.has(s))
    if (unknown.length)
      return { content: `Error: not an image id or image URL from this conversation: ${unknown.join(', ')}` }
    if (state.batch.iteration !== iteration) state.batch = { iteration, count: 0 }

    const store = ctx.llm.images
    const lines: string[] = []
    const ids: string[] = []
    for (const item of wanted) {
      const isUrl = /^https?:/.test(item)
      const hinted = isUrl ? store.idOfUrl(item) : item
      if (hinted && state.seen.has(hinted)) {
        lines.push(`${item}: already viewed earlier in this conversation; see above`)
        continue
      }
      if (state.batch.count >= VIEW_IMAGES_PER_BATCH || state.viewed >= VIEW_IMAGES_PER_TURN) {
        const cap = state.viewed >= VIEW_IMAGES_PER_TURN
          ? `${VIEW_IMAGES_PER_TURN} per turn`
          : `${VIEW_IMAGES_PER_BATCH} per batch of calls; view it in a later step`
        lines.push(`${item}: not attached, limit is ${cap}`)
        continue
      }
      // Downloaded only now, and only if not stored already.
      let id: string | undefined
      try {
        if (!isUrl && (await store.get(item))) id = item
        else {
          const url = isUrl ? item : store.urlOf(item)
          if (url) id = (await store.fetch(url)).id
        }
      } catch (e) {
        logger.warn('[view_image] fetch failed: %s', (e as Error)?.message ?? e)
      }
      if (!id) {
        lines.push(`${item}: ${EXPIRED}`)
        continue
      }
      const ref = await store.get(id)
      state.known.add(id)
      state.seen.add(id)
      state.batch.count++
      state.viewed++
      ids.push(id)
      lines.push(`${item}: ${ref ? imageTag(ref) : `<image id="${id}"/>`} attached below`)
    }
    return { content: lines.join('\n'), images: ids }
  },
}
