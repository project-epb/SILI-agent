import { Context, Random } from 'koishi'
import type { Config, OAuthTokens } from './types'
import type { GitHubHttp } from './http'

const sanitize = (p: string) => (p.endsWith('/') ? p.slice(0, -1) : p)

/** Build the GitHub OAuth authorize URL (scope admin:repo_hook,repo). */
export function buildAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    state,
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'admin:repo_hook,repo',
  })
  return 'https://github.com/login/oauth/authorize?' + params.toString()
}

export interface OAuthCallbackDeps {
  /** Return the koishi user id for a state token and consume (delete) it; undefined if unknown. */
  consumeState(state: string): number | undefined
  exchangeCode(code: string, state: string): Promise<OAuthTokens>
  /** Fetch the GitHub username for a fresh access token. MUST be fail-soft (return undefined on error, never throw). */
  fetchUsername(accessToken: string): Promise<string | undefined>
  storeTokens(userId: number, tokens: OAuthTokens, username?: string): Promise<void>
}

/** Pure OAuth callback core. Status order mirrors the old plugin: 400 bad state, 403 unknown, 200 ok. */
export async function handleOAuthCallback(
  query: Record<string, any>,
  deps: OAuthCallbackDeps
): Promise<{ status: number; username?: string }> {
  const state = query.state
  if (!state || Array.isArray(state)) return { status: 400 }
  const userId = deps.consumeState(String(state))
  if (userId === undefined) return { status: 403 }
  const tokens = await deps.exchangeCode(String(query.code), String(state))
  const username = await deps.fetchUsername(tokens.access_token)
  await deps.storeTokens(userId, tokens, username)
  return { status: 200, username }
}

/** Pure: a clean self-contained HTML page for the OAuth callback (200 = success, else failure). */
export function renderCallbackPage(status: number, username?: string): string {
  const ok = status === 200
  const accent = ok ? '#2ea043' : '#cf222e'
  const icon = ok ? '&#10003;' : '&#10005;' // ✓ / ✕
  const title = ok ? '绑定成功' : '授权失败'
  // username is external data rendered into HTML; keep only [A-Za-z0-9_-] defensively.
  const safe = username ? String(username).replace(/[^\w-]/g, '') : ''
  const message = ok
    ? (safe ? `已绑定 @${safe}，你现在可以安全地关闭此网页。` : '你现在可以安全地关闭此网页。')
    : '授权链接无效或已过期，请回到聊天中重新发起授权。'
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GitHub · ${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f6f8fa; color: #1f2328; }
  @media (prefers-color-scheme: dark) { body { background: #0d1117; color: #e6edf3; } .card { background: #161b22; border-color: #30363d; } }
  .card { background: #fff; border: 1px solid #d0d7de; border-radius: 12px; padding: 40px 48px;
    text-align: center; max-width: 360px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  .icon { width: 56px; height: 56px; line-height: 56px; border-radius: 50%; margin: 0 auto 20px;
    font-size: 28px; color: #fff; background: ${accent}; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0; font-size: 14px; opacity: .75; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`
}

/** Register the authorize command + OAuth callback route. */
export function applyOAuth(ctx: Context, config: Config, http: GitHubHttp): void {
  const path = sanitize(config.path ?? '/github')
  const states: Record<string, number> = Object.create(null) // state token -> koishi user id
  // Effective redirect_uri: explicit config.redirect override, else derive the callback route's
  // own URL from the configured public selfUrl. The SAME value must be used for the authorize
  // link and the code exchange, so it is computed once here.
  const redirectUri = () => config.redirect || ctx.server.config.selfUrl + path + '/authorize'

  ctx
    .command('github.authorize')
    .alias('github.auth')
    .userFields(['id'])
    .action(({ session }) => {
      const state = Random.id()
      states[state] = session!.user!.id
      // '.follow-link' in the old locale = '请点击下面的链接继续操作：'
      return '请点击下面的链接继续操作：\n' + buildAuthorizeUrl(config.appId ?? '', redirectUri(), state)
    })

  ctx.server.get(path + '/authorize', async (koa) => {
    const result = await handleOAuthCallback(koa.query, {
      consumeState: (s) => {
        const id = states[s]
        if (id === undefined) return undefined
        delete states[s]
        return id
      },
      exchangeCode: (code, state) => http.getTokens({ code, state, redirect_uri: redirectUri() }),
      fetchUsername: async (accessToken) => {
        try {
          return (await http.getUser(accessToken)).login
        } catch {
          return undefined // fail-soft: OAuth still succeeds without the username
        }
      },
      storeTokens: async (id, t, username) => {
        await ctx.database.set('user', { id }, {
          'github.accessToken': t.access_token,
          'github.refreshToken': t.refresh_token,
          ...(username ? { 'github.username': username } : {}),
        })
      },
    })
    koa.status = result.status
    koa.type = 'html'
    koa.body = renderCallbackPage(result.status, result.username)
  })
}
