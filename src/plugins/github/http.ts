import type { Context } from 'koishi'
import type { Config, OAuthTokens, GitHubUser } from './types'

export type { OAuthTokens, GitHubUser } from './types'

const API = 'https://api.github.com'
const RETRY_BACKOFF_MS = 500 // wait before retrying a transient network failure on token exchange
const authHeaders = (token: string) => ({
  authorization: `token ${token}`,
  accept: 'application/vnd.github.v3+json',
})

/** ctx.http (Quester) wrapper for GitHub REST + OAuth. No octokit (Phase 3 decision A). */
export class GitHubHttp {
  constructor(private ctx: Context, private config: Config) {}

  /** Exchange an OAuth code (or refresh_token) for tokens. Creds + params go in the request
   * BODY, never the query string — a failed-request log embeds the URL, so a query-string
   * client_secret would leak into logs. On a network-layer failure (no HTTP response) retry
   * once: GitHub connectivity from some hosts is flaky and a single retry absorbs transient
   * TLS/connect timeouts. A real HTTP error (bad code → 4xx) is not retried. */
  async getTokens(params: Record<string, any>): Promise<OAuthTokens> {
    const body = { client_id: this.config.appId, client_secret: this.config.appSecret, ...params }
    const post = (): Promise<OAuthTokens> =>
      this.ctx.http.post('https://github.com/login/oauth/access_token', body, {
        headers: { accept: 'application/json' },
      })
    try {
      return await post()
    } catch (e: any) {
      if (e?.response) throw e // real HTTP error: retrying won't help
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS)) // transient network failure
      return await post()
    }
  }

  /** Fetch the authenticated user's profile (login = GitHub username). Fresh token, no refresh. */
  getUser(accessToken: string): Promise<{ login: string }> {
    return this.ctx.http.get(`${API}/user`, {
      headers: { authorization: `token ${accessToken}`, accept: 'application/vnd.github.v3+json' },
    })
  }

  /** Run an authed call; on 401 refresh the user's token, persist it, and retry once. */
  private async withAuth<T>(user: GitHubUser, fn: (token: string) => Promise<T>): Promise<T> {
    try {
      return await fn(user.github.accessToken)
    } catch (e: any) {
      if (e?.response?.status !== 401) throw e
      const t = await this.getTokens({
        refresh_token: user.github.refreshToken,
        grant_type: 'refresh_token',
      })
      await this.ctx.database.set('user', { id: user.id }, {
        'github.accessToken': t.access_token,
        'github.refreshToken': t.refresh_token,
      })
      user.github.accessToken = t.access_token
      user.github.refreshToken = t.refresh_token
      return await fn(t.access_token)
    }
  }

  createWebhook(
    user: GitHubUser,
    repo: string,
    opts: { secret: string; callbackUrl: string }
  ): Promise<{ id: number }> {
    return this.withAuth(user, (token) =>
      this.ctx.http.post(
        `${API}/repos/${repo}/hooks`,
        { events: ['*'], config: { url: opts.callbackUrl, secret: opts.secret } },
        { headers: authHeaders(token) }
      )
    )
  }

  async deleteWebhook(user: GitHubUser, repo: string, hookId: number): Promise<void> {
    try {
      await this.withAuth(user, (token) =>
        this.ctx.http.delete(`${API}/repos/${repo}/hooks/${hookId}`, { headers: authHeaders(token) })
      )
    } catch (e: any) {
      if (e?.response?.status === 404) return // hook already gone
      throw e
    }
  }
}
