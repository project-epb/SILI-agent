// HTTP shorthand methods (http.get / http.post) in @cordisjs/plugin-http return
// the decoded response body directly — not an HTTP.Response wrapper. This client
// therefore treats every shorthand return value as the body itself.
import type { HTTP } from '@cordisjs/plugin-http'

/** Gelbooru dapi base endpoint — all queries are query-string variations of this. */
export const BASE = 'https://gelbooru.com/index.php'
export const USER_AGENT = 'gelbooru-sili/0.1'

/** A trimmed gelbooru post (only the fields we surface to agents). */
export interface GelbooruPost {
  id: number
  score: number
  rating: string
  tags: string
  sample_url: string
  [k: string]: unknown
}

/** A gelbooru tag record (subset of fields). */
export interface GelbooruTag {
  name: string
  count: number
  type: number
  [k: string]: unknown
}

/**
 * Error classification for Gelbooru client operations.
 * - auth: 401 — credentials missing/invalid (gelbooru dapi rejects anonymous calls).
 * - network: the request itself could not be made (DNS, refused, timeout, etc).
 * - http_error: any other unexpected HTTP/response error.
 */
export type GelbooruErrorType = 'auth' | 'network' | 'http_error'

export class GelbooruError extends Error {
  type: GelbooruErrorType
  constructor(message: string, type: GelbooruErrorType) {
    super(message)
    this.name = 'GelbooruError'
    this.type = type
  }
}

/**
 * Extract a list out of a gelbooru dapi JSON payload. Gelbooru sometimes returns
 * `{"@attributes": {...}, "post": [...]}` (or `tag`) as a dict, and sometimes a
 * bare array — this normalises both. Missing key / null / non-collection → [].
 *
 * Pure function — kept here (not in a koishi module) so it stays unit-testable.
 */
export function extractList<T = any>(payload: unknown, key: string): T[] {
  if (Array.isArray(payload)) return payload as T[]
  if (payload && typeof payload === 'object') {
    const v = (payload as Record<string, unknown>)[key]
    return Array.isArray(v) ? (v as T[]) : []
  }
  return []
}

export interface GelbooruAuth {
  apiKey: string
  userId: string
}

export interface LookupTagsParams {
  name?: string
  names?: string
  namePattern?: string
  orderby?: 'date' | 'count' | 'name'
  order?: 'ASC' | 'DESC'
  limit?: number
}

export interface SearchPostsParams {
  limit?: number
  pid?: number
}

/**
 * Thin wrapper around the Gelbooru dapi, built on koishi's `ctx.http`.
 *
 * Auth is sent as query parameters (`api_key` + `user_id`), NOT headers — this
 * is how gelbooru's dapi expects it.
 */
export class GelbooruClient {
  constructor(
    private http: HTTP,
    private auth: GelbooruAuth
  ) {}

  private authParams(): Record<string, string> {
    return { api_key: this.auth.apiKey, user_id: this.auth.userId }
  }

  private toGelbooruError(e: any): GelbooruError {
    if (this.http.isError(e)) {
      const status = e.response?.status
      if (status === 401) {
        return new GelbooruError(
          'HTTP 401: gelbooru credentials were rejected. Check GELBOORU_API_KEY / GELBOORU_USER_ID against the account options page.',
          'auth'
        )
      }
      if (status === undefined) {
        return new GelbooruError(`network error: ${e.message}`, 'network')
      }
      return new GelbooruError(`HTTP ${status}: ${e.message}`, 'http_error')
    }
    if (e instanceof GelbooruError) return e
    return new GelbooruError(String(e?.message ?? e), 'http_error')
  }

  /** GET ?page=dapi&s=tag&q=index&json=1 → tag records. */
  async lookupTags(params: LookupTagsParams): Promise<GelbooruTag[]> {
    const query: Record<string, string> = {
      page: 'dapi',
      s: 'tag',
      q: 'index',
      json: '1',
      limit: String(params.limit ?? 20),
      ...this.authParams(),
    }
    if (params.name) query.name = params.name
    if (params.names) query.names = params.names
    if (params.namePattern) query.name_pattern = params.namePattern
    if (params.orderby) query.orderby = params.orderby
    if (params.order) query.order = params.order

    let data: unknown
    try {
      data = await this.http.get(BASE, { params: query })
    } catch (e) {
      throw this.toGelbooruError(e)
    }
    return extractList<GelbooruTag>(data, 'tag')
  }

  /** GET ?page=dapi&s=post&q=index&json=1&tags=... → post records. */
  async searchPosts(
    tags: string,
    params: SearchPostsParams = {}
  ): Promise<GelbooruPost[]> {
    const query: Record<string, string> = {
      page: 'dapi',
      s: 'post',
      q: 'index',
      json: '1',
      tags,
      limit: String(params.limit ?? 10),
      pid: String(params.pid ?? 0),
      ...this.authParams(),
    }

    let data: unknown
    try {
      data = await this.http.get(BASE, { params: query })
    } catch (e) {
      throw this.toGelbooruError(e)
    }
    return extractList<GelbooruPost>(data, 'post')
  }
}
