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
  /** OneBot `message_seq` — the cursor `read_channel_history` pages by. */
  seq?: number
}

/** Pull what satori knows about the quoted message off the session. */
export function extractQuoteMeta(session: any): QuotedMessageMeta | undefined {
  const quote = session?.quote
  if (!quote) return undefined
  return {
    content: quote.content ?? '',
    author: quote.member?.nick || quote.user?.name || undefined,
    authorId: quote.user?.id,
    self: !!quote.user?.id && quote.user.id === session.selfId,
  }
}

/**
 * Look up the quoted message's OneBot `message_seq`, the cursor
 * `read_channel_history` pages by.
 *
 * satori's `Message` has no seq field, so the adapter drops it while building
 * `session.quote` — koishi's own `getMessageList` re-fetches via `get_msg` for the
 * same reason. Costs one local WS round-trip, and only when a quote is present.
 *
 * Best-effort by design: any platform without `get_msg`, any API failure, and we
 * simply omit the cursor rather than lose the quote.
 */
export async function resolveQuoteSeq(
  bot: any,
  messageId: string | undefined
): Promise<number | undefined> {
  if (!messageId || typeof bot?.internal?.getMsg !== 'function') return undefined
  try {
    const msg = await bot.internal.getMsg(messageId)
    return typeof msg?.message_seq === 'number' ? msg.message_seq : undefined
  } catch {
    return undefined
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
    attr('seq', meta.seq)
  return `<${TAG}${attrs}>\n${body}\n</${TAG}>`
}
