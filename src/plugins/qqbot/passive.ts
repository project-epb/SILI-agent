/** QQ allows this many passive replies to one user message. */
const PASSIVE_REPLY_LIMIT = 5
const MEDIA_TYPES = new Set(['img', 'image', 'video', 'audio', 'file'])

interface Element {
  type: string
  children?: Element[]
}

function countMedia(elements: Element[] = []): number {
  return elements.reduce(
    (n, el) => n + (MEDIA_TYPES.has(el.type) ? 1 : 0) + countMedia(el.children),
    0
  )
}

/**
 * Past the passive reply limit, qq-crack still sends with the same msg_id and
 * QQ rejects it: the message is lost. Send those as proactive messages instead
 * by handing the encoder a source session without messageId or event id.
 *
 * qq-crack counts passive replies in `session.seq`, one per flush, and each
 * media element flushes on its own: a send needs (media count + 1) of them.
 * The whole send goes proactive if it would not fit.
 */
export function passiveFallback(
  out: { elements?: Element[] },
  options: { session?: any } | undefined
) {
  const source = options?.session
  if (!source || source.platform !== 'qq' || !source.messageId) return
  const used: number = source.seq ?? 0
  if (used + countMedia(out.elements) + 1 <= PASSIVE_REPLY_LIMIT) return
  options!.session = Object.create(source, {
    messageId: { value: undefined },
    qq: { value: undefined },
  })
}
