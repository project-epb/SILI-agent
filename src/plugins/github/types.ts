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
  /** Max characters of an issue/PR/comment body before truncation. Default 500; 0 = no limit. */
  bodyMaxLength?: number
}

/** Per-channel event filter meta, keyed by camelized event name.
 * `false` disables the whole event; a nested map disables specific camelized actions. */
export type EventFilter = Record<string, boolean | Record<string, boolean>>

/** A repo's subscribers: cid ('platform:id') -> filter meta. */
export type RepoConfig = Record<string, EventFilter>

/** Options threaded into renderers (e.g. body truncation length). */
export interface RenderOptions {
  bodyMaxLength: number
}

/** Renders a parsed webhook payload into a chat message, or null to skip.
 * Renderers that don't need `opts` may omit the parameter. */
export type EventRenderer = (payload: any, opts: RenderOptions) => Fragment | null
