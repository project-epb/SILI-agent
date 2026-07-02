import type { Context } from 'koishi'
import type { Config, OAuthTokens, GitHubUser } from './types'

export type { OAuthTokens, GitHubUser } from './types'

const API = 'https://api.github.com'
const authHeaders = (token: string) => ({
  authorization: `token ${token}`,
  accept: 'application/vnd.github.v3+json',
})

/** ctx.http (Quester) wrapper for GitHub REST + OAuth. No octokit (Phase 3 decision A). */
export class GitHubHttp {
  constructor(private ctx: Context, private config: Config) {}

  /** Exchange an OAuth code (or refresh_token) for tokens. Params go on the query string. */
  getTokens(params: Record<string, any>): Promise<OAuthTokens> {
    return this.ctx.http.post('https://github.com/login/oauth/access_token', {}, {
      params: { client_id: this.config.appId, client_secret: this.config.appSecret, ...params },
      headers: { accept: 'application/json' },
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
