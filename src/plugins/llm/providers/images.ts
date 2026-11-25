import type { ChatMessage, ImageSource } from './_base'

export const IMAGE_EXPIRED_NOTE = '（这张图已过期，看不到了）'
export const IMAGE_UNSEEN_NOTE = '（这里有一张图，但当前模型看不到图片）'

export type UserPart =
  | { type: 'text'; text: string }
  | { type: 'image'; id: string }

const tagOf = (id: string) => new RegExp(`<image id="${id}"[^>]*/>`)

/**
 * Split a user message into text and image parts: each attached image goes
 * right after its `<image id=…/>` tag; one without a tag goes at the end.
 */
export function splitImages(content: string, images: string[]): UserPart[] {
  const parts: UserPart[] = []
  let rest = content
  const trailing: string[] = []
  for (const id of images) {
    const m = tagOf(id).exec(rest)
    if (!m) {
      trailing.push(id)
      continue
    }
    const end = m.index + m[0].length
    parts.push({ type: 'text', text: rest.slice(0, end) }, { type: 'image', id })
    rest = rest.slice(end)
  }
  if (rest) parts.push({ type: 'text', text: rest })
  for (const id of trailing) parts.push({ type: 'image', id })
  return parts
}

/**
 * Images brought in by tool results go in one user message right after the
 * batch of results, each wrapped with the call it belongs to. Some models
 * and gateways serialize files inside tool results to byte arrays: the
 * model sees no picture and pays the tokens. Live turns and replayed
 * history both pass through here, so they produce the same bytes.
 */
export function withToolAttachments(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  let pending: { callId: string; id: string }[] = []
  const flush = () => {
    if (!pending.length) return
    out.push({
      role: 'user',
      content: pending
        .map((a) => `<tool_attachment call_id="${a.callId}" image="${a.id}">\n<image id="${a.id}"/>\n</tool_attachment>`)
        .join('\n'),
      images: pending.map((a) => a.id),
    })
    pending = []
  }
  for (const m of messages) {
    if (m.role !== 'tool') flush()
    out.push(m)
    if (m.role === 'tool' && m.images?.length)
      for (const id of m.images) pending.push({ callId: m.tool_call_id, id })
  }
  flush()
  return out
}

export type ResolvedPart =
  | { type: 'text'; text: string }
  | { type: 'image'; id: string; bytes: Uint8Array; mime: string }

/**
 * A user message's parts with image bytes loaded. Without vision, or once
 * an image is evicted, its place gets a note so the history still sends.
 */
export async function resolveUserParts(
  m: Extract<ChatMessage, { role: 'user' }>,
  vision: boolean,
  source: ImageSource | undefined
): Promise<ResolvedPart[]> {
  const out: ResolvedPart[] = []
  for (const part of splitImages(m.content, m.images ?? [])) {
    if (part.type === 'text') {
      out.push(part)
      continue
    }
    const img = vision ? await source?.read(part.id) : undefined
    out.push(
      img
        ? { type: 'image', id: part.id, bytes: img.bytes, mime: img.type }
        : { type: 'text', text: vision ? IMAGE_EXPIRED_NOTE : IMAGE_UNSEEN_NOTE }
    )
  }
  return mergeText(out)
}

/** Join adjacent text parts. */
export function mergeText<T extends { type: string }>(parts: T[]): T[] {
  const out: T[] = []
  for (const p of parts) {
    const last = out[out.length - 1] as any
    if (p.type === 'text' && last?.type === 'text') last.text += (p as any).text
    else out.push(p.type === 'text' ? ({ ...p } as T) : p)
  }
  return out
}

export const dataUrl = (bytes: Uint8Array, mime: string) =>
  `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
