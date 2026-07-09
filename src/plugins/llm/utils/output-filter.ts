import { h } from '@koishijs/core'

import {
  type BBCodeElement,
  type BBCodeNode,
  getAttr,
  parseKoishiBBCode,
} from './koishi-bbcode'

/**
 * URL safety check: only `http(s)://` is accepted on `src`/`href`.
 * Anything else is untrusted (placeholder, attack URL, etc).
 */
function isSafeHttpUrl(url: string | undefined): boolean {
  if (!url) return false
  return /^https?:\/\//i.test(url)
}

/**
 * Has a URL-like scheme that isn't http(s) — potentially dangerous
 * (`file://`, `javascript:`, `data:`, ...). Used to decide whether an
 * invalid real element gets silently dropped (security: don't surface
 * attack URLs as text either) vs escaped as literal prose.
 */
function hasDangerousScheme(url: string | undefined): boolean {
  if (!url) return false
  if (isSafeHttpUrl(url)) return false
  return /^[a-z][a-z0-9+.\-]*:/i.test(url)
}

/** Protocol-only markers — emitted by the agent for flow control, never
 *  user-visible. */
const PROTOCOL_DROP_TAGS: ReadonlySet<string> = new Set([
  'msg_break',
  'silent',
  'interrupted',
])

/** Paired tags the parser must look for `[/koishi:tag]` close. */
const PAIRED_TAGS: ReadonlySet<string> = new Set(['a'])

/**
 * Sanitize an agent-emitted chunk. Two-layer pipeline:
 *
 *   - **Structure (delegated to `parseKoishiBBCode`)**: turn the raw
 *     string into `[text | element]` nodes. Elements only ever match
 *     bracket-form `[koishi:tag ...]` patterns, never angle brackets.
 *   - **Policy (this file)**: walk the nodes and decide per type. Text
 *     escapes via `h.text()`. Elements get tag-specific validation and
 *     translation into real koishi elements (`<img>` / `<a>`), dropped
 *     entirely (protocol markers, attack URLs), or downgraded to escaped
 *     literal text (placeholder URLs, unknown tags).
 *
 * The split keeps the parser reusable and individually testable, and
 * isolates LLM-specific policy from syntax.
 */
export function sanitizeAgentOutput(text: string): string {
  if (!text) return text

  const nodes = parseKoishiBBCode(text, { pairedTags: PAIRED_TAGS })
  return nodes.map(renderNode).join('')
}

function renderNode(node: BBCodeNode): string {
  if (node.kind === 'text') {
    return h.text(node.content).toString()
  }
  return renderElement(node)
}

function renderElement(el: BBCodeElement): string {
  if (PROTOCOL_DROP_TAGS.has(el.tag.toLowerCase())) {
    return '' // internal flow signal; never user-visible
  }
  if (el.tag.toLowerCase() === 'img') {
    return renderImg(el)
  }
  if (el.tag.toLowerCase() === 'a') {
    return renderA(el)
  }
  // Unknown tag — escape the raw source so user sees what the agent wrote.
  return h.text(el.raw).toString()
}

function renderImg(el: BBCodeElement): string {
  const src = getAttr(el, 'src')
  const ref = getAttr(el, 'ref')
  if (ref && !src) {
    // Trusted system placeholder (resolved to data: URI later).
    return h('img', { ref }).toString()
  }
  if (isSafeHttpUrl(src)) {
    return h('img', { src }).toString()
  }
  if (hasDangerousScheme(src)) {
    // Drop entirely — don't broadcast the attack URL even as text.
    return ''
  }
  // Placeholder / missing src: surface as literal so user can see what
  // the agent wrote (helps debug agent mistakes).
  return h.text(el.raw).toString()
}

function renderA(el: BBCodeElement): string {
  const href = getAttr(el, 'href')
  const inner = el.inner ?? ''
  if (isSafeHttpUrl(href)) {
    return h('a', { href }, h.text(inner)).toString()
  }
  if (hasDangerousScheme(href)) {
    // Drop URL, keep link text so sentence still reads.
    return h.text(inner).toString()
  }
  // Placeholder href — escape entire tag as literal.
  return h.text(el.raw).toString()
}
