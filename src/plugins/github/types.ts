import type { Fragment } from 'koishi'

export interface Config {
  /** Base path of the GitHub service routes. Prod uses '/api/github'. */
  path?: string
  appId?: string
  appSecret?: string
  redirect?: string
  /** Prepended to every pushed message. */
  messagePrefix?: string
  replyFooter?: string
  replyTimeout?: number
}

/** Per-channel event filter meta, keyed by camelized event name.
 * `false` disables the whole event; a nested map disables specific camelized actions. */
export type EventFilter = Record<string, boolean | Record<string, boolean>>

/** A repo's subscribers: cid ('platform:id') -> filter meta. */
export type RepoConfig = Record<string, EventFilter>

/** Renders a parsed webhook payload into a chat message, or null to skip. */
export type EventRenderer = (payload: any) => Fragment | null
