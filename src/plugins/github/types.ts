import type { Fragment } from '@koishijs/core'

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

/** OAuth token pair as returned by GitHub's access_token endpoint. */
export interface OAuthTokens {
  access_token: string
  refresh_token: string
}

/** The subset of a koishi user this plugin reads/writes (userFields(['id','github'])). */
export interface GitHubUser {
  id: number
  github: { accessToken: string; refreshToken: string; username?: string }
}

// koishi table augmentations. This self-written plugin owns the github schema types now
// (replacing the dead koishi-plugin-github, whose d.ts we no longer import); `username`
// is the field Task 7 adds. Shapes mirror the legacy schema so existing data keeps working.
declare module 'koishi' {
  interface User {
    github: { accessToken: string; refreshToken: string; username?: string }
  }
  interface Channel {
    github: { webhooks: Record<string, EventFilter> }
  }
  interface Tables {
    github: { id: number; name: string; secret: string }
  }
}
