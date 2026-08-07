import { PROTOCOL_ELEMENT_TYPES } from './protocol'

const TAG = PROTOCOL_ELEMENT_TYPES.QUOTED_MESSAGE

/** What we know about the message the user quote-replied to. */
export interface QuotedMessageMeta {
  /** Satori h-element string, exactly as the adapter produced it. */
  content: string
  /** Display name of whoever wrote it. */
  author?: string
  authorId?: string
  /** True when the quoted message is one SILI sent herself. */
  self?: boolean
  /** Platform message id — what `read_channel_history`'s `before_message_id` takes. */
  messageId?: string
}

/** Pull what satori knows about the quoted message off the session. */
export function extractQuoteMeta(session: any): QuotedMessageMeta | undefined {
  const quote = session?.quote
  if (!quote) return undefined
  return {
    content: quote.content ?? '',
    author: quote.member?.nick || quote.user?.name || undefined,
    authorId: quote.user?.id,
    messageId: quote.id,
    self: !!quote.user?.id && quote.user.id === session.selfId,
  }
}

function attr(name: string, value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  const escaped = String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  return ` ${name}="${escaped}"`
}

/**
 * Render the quoted message as a `<quoted_message>` block for the turn envelope.
 * Returns '' when there is nothing to say, so the caller can concatenate blindly.
 *
 * The body is passed through untouched: satori already escapes text nodes when it
 * serializes (`Element.escape`), so any `<` left in `content` is a real element tag
 * — the same `<img …/>` / `<at …/>` shapes `read_channel_history` feeds the agent.
 * Escaping again would hide them; not escaping is safe because a user cannot forge
 * a closing tag through it.
 *
 * Attribute order is fixed: the block is persisted into `openai_chat` and replayed
 * next turn, so byte drift would cost the provider's prefix cache.
 */
export function buildQuotedMessageBlock(
  meta: QuotedMessageMeta,
  maxLength: number
): string {
  let body = (meta.content ?? '').trim()
  if (!body) return ''
  if (maxLength > 0 && body.length > maxLength) body = body.slice(0, maxLength) + '…'
  const attrs =
    attr('author', meta.author) +
    attr('author_id', meta.authorId) +
    (meta.self ? ' self="true"' : '') +
    attr('message_id', meta.messageId)
  return `<${TAG}${attrs}>\n${body}\n</${TAG}>`
}
