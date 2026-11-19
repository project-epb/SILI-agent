import { STICKER_TYPES, stickerTypeLines } from './types'

export interface VisionConfig {
  baseURL: string
  apiKey: string
  model: string
}

export interface VisionVerdict {
  isSticker: boolean
  tags: string[]
  desc: string
  tokens: number
}

const SYSTEM = `你在帮 QQ 群聊机器人整理表情库。给你一张群友发的图片，判断它是不是表情包，是的话写一句描述并标出情绪类型。只输出 JSON。

表情包：在聊天里用来表达情绪或态度的图，比如角色表情、动物表情、带一两句梗文字的反应图、经典梗图。
不是表情包：截图（网页、聊天、游戏、软件）、照片（食物、风景、人物合影）、多格漫画、长图、大段文字。

可选类型（tags 只能用这些名字）：
${stickerTypeLines()}

输出格式：{"is_sticker": true|false, "tags": ["…"], "desc": "…"}
- desc 只描述画面本身：主体、表情、动作、画风；图里有文字就照抄。不超过 20 字。不要写它表达什么情绪、适合什么场合。
- tags 选 1 到 3 个，按主要程度排序。「其他」只在其余类型都不贴切时才用。
- 不是表情包时 tags 为空数组、desc 为空字符串。`

/**
 * One call per picture. The original bytes go straight in — DeepSeek takes
 * animated gifs and full-size images, and the core image has no raster library
 * to downscale with. Callers cap the file size instead.
 */
export async function classifySticker(
  config: VisionConfig,
  image: Buffer,
  mime: string,
  options: { forceSticker?: boolean; signal?: AbortSignal } = {}
): Promise<VisionVerdict> {
  const res = await fetch(
    `${config.baseURL.replace(/\/$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 200,
        temperature: 0,
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mime};base64,${image.toString('base64')}`,
                },
              },
              {
                type: 'text',
                text: options.forceSticker
                  ? '这是一张表情包，描述它并标出类型。'
                  : '判断这张图。',
              },
            ],
          },
        ],
      }),
      signal: options.signal ?? AbortSignal.timeout(60_000),
    }
  )
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok)
    throw new Error(
      `vision ${res.status}: ${JSON.stringify(json?.error ?? json).slice(0, 200)}`
    )
  const tokens =
    (json.usage?.prompt_tokens ?? 0) + (json.usage?.completion_tokens ?? 0)
  const out = parseVerdict(json.choices?.[0]?.message?.content ?? '')
  return { ...out, isSticker: options.forceSticker || out.isSticker, tokens }
}

export function parseVerdict(text: string): Omit<VisionVerdict, 'tokens'> {
  let raw: any
  try {
    raw = JSON.parse(text.replace(/^```(?:json)?\s*|```\s*$/g, ''))
  } catch {
    throw new Error(`vision returned non-JSON: ${text.slice(0, 120)}`)
  }
  const known = new Set<string>(STICKER_TYPES)
  const tags = (Array.isArray(raw.tags) ? raw.tags : [])
    .filter((t: unknown) => typeof t === 'string' && known.has(t))
    .slice(0, 3)
  return {
    isSticker: raw.is_sticker === true,
    tags: tags.length ? tags : ['其他'],
    desc: typeof raw.desc === 'string' ? raw.desc.slice(0, 40) : '',
  }
}
