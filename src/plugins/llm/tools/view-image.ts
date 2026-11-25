import type { ToolDefinition } from '../providers/_base'
import { turnImages } from '../utils/inbound-images'
import type { ToolHandler, ToolResult } from './types'

export const VIEW_IMAGES_PER_CALL = 4
export const VIEW_IMAGES_PER_TURN = 8

export const VIEW_IMAGE_TOOL: ToolDefinition = {
  name: 'view_image',
  description: `查看图片。ids 取自 \`<image id="…"/>\` 的 id，一次最多 ${VIEW_IMAGES_PER_CALL} 张，每轮合计最多 ${VIEW_IMAGES_PER_TURN} 张。`,
  parameters: {
    type: 'object',
    properties: {
      ids: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: VIEW_IMAGES_PER_CALL,
      },
    },
    required: ['ids'],
    additionalProperties: false,
  },
}

export const viewImageHandler: ToolHandler = {
  definition: VIEW_IMAGE_TOOL,
  async execute(args, { turnState }): Promise<ToolResult> {
    const ids = [...new Set(Array.isArray(args?.ids) ? args.ids.map(String) : [])]
    if (!ids.length) return { content: 'Error: ids is empty.' }
    if (ids.length > VIEW_IMAGES_PER_CALL)
      return { content: `Error: at most ${VIEW_IMAGES_PER_CALL} images per call.` }
    const state = turnImages(turnState)
    const unknown = ids.filter((id) => !state.known.has(id))
    if (unknown.length)
      return { content: `Error: no image with id ${unknown.join(', ')} in this conversation.` }
    if (state.viewed + ids.length > VIEW_IMAGES_PER_TURN)
      return {
        content: `Error: at most ${VIEW_IMAGES_PER_TURN} images per turn; ${VIEW_IMAGES_PER_TURN - state.viewed} left.`,
      }
    state.viewed += ids.length
    return { content: `Attached below: ${ids.join(', ')}`, images: ids }
  },
}
