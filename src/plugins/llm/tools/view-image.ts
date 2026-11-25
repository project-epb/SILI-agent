import type { ToolDefinition } from '../providers/_base'
import { imageTag } from '../services/image-store'
import { decodeUrl, turnImages } from '../utils/inbound-images'
import type { ToolHandler, ToolResult } from './types'

export const VIEW_IMAGES_PER_CALL = 4
export const VIEW_IMAGES_PER_TURN = 8

export const VIEW_IMAGE_TOOL: ToolDefinition = {
  name: 'view_image',
  description: `查看图片。images 每项是 \`<image id="…"/>\` 的 id，或聊天记录里 \`<img src="…"/>\` 的 URL（原样复制）。一次最多 ${VIEW_IMAGES_PER_CALL} 张，每轮合计最多 ${VIEW_IMAGES_PER_TURN} 张。`,
  parameters: {
    type: 'object',
    properties: {
      images: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: VIEW_IMAGES_PER_CALL,
      },
    },
    required: ['images'],
    additionalProperties: false,
  },
}

export const viewImageHandler: ToolHandler = {
  definition: VIEW_IMAGE_TOOL,
  async execute(args, { ctx, turnState, logger }): Promise<ToolResult> {
    const wanted = [
      ...new Set(
        (Array.isArray(args?.images) ? args.images : [])
          .map((s: unknown) => String(s).trim())
          .map((s: string) => (/^https?:/.test(s) ? decodeUrl(s) : s))
      ),
    ] as string[]
    if (!wanted.length) return { content: 'Error: images is empty.' }
    if (wanted.length > VIEW_IMAGES_PER_CALL)
      return { content: `Error: at most ${VIEW_IMAGES_PER_CALL} images per call.` }
    const state = turnImages(turnState)
    const unknown = wanted.filter((s) => !state.known.has(s))
    if (unknown.length)
      return { content: `Error: not an image id or image URL from this conversation: ${unknown.join(', ')}` }
    if (state.viewed + wanted.length > VIEW_IMAGES_PER_TURN)
      return {
        content: `Error: at most ${VIEW_IMAGES_PER_TURN} images per turn; ${VIEW_IMAGES_PER_TURN - state.viewed} left.`,
      }
    // A URL is downloaded and stored only now, when the model asks for it.
    const lines: string[] = []
    const ids: string[] = []
    for (const item of wanted) {
      if (!/^https?:/.test(item)) {
        lines.push(`${item}: attached below`)
        ids.push(item)
        continue
      }
      try {
        const ref = await ctx.llm.images.fetch(item)
        state.known.add(ref.id)
        lines.push(`${item} → ${imageTag(ref)}: attached below`)
        ids.push(ref.id)
      } catch (e) {
        logger.warn('[view_image] fetch failed: %s', (e as Error)?.message ?? e)
        lines.push(`${item}: could not be downloaded (the link may have expired)`)
      }
    }
    state.viewed += ids.length
    return { content: lines.join('\n'), images: ids }
  },
}
