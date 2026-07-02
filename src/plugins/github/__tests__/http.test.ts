import { describe, it, expect, vi } from 'vitest'
import { GitHubHttp, type GitHubUser } from '../http'

// Minimal fake koishi Context: only the surface GitHubHttp touches.
function makeCtx(overrides: any = {}) {
  const http: any = Object.assign(vi.fn(), { post: vi.fn(), delete: vi.fn(), get: vi.fn() })
  return {
    http,
    database: { set: vi.fn().mockResolvedValue(undefined) },
    server: { config: { selfUrl: 'https://sili.example' } },
    ...overrides,
  } as any
}
const config = { appId: 'cid', appSecret: 'csec', path: '/api/github' } as any
const user = (): GitHubUser => ({ id: 7, github: { accessToken: 'at0', refreshToken: 'rt0' } })

describe('getTokens', () => {
  it('posts to the access_token endpoint with client creds + params in the BODY, Accept json', async () => {
    const ctx = makeCtx()
    ctx.http.post.mockResolvedValue({ access_token: 'AT', refresh_token: 'RT' })
    const http = new GitHubHttp(ctx, config)
    const out = await http.getTokens({ code: 'C', state: 'S', redirect_uri: 'R' })
    expect(out).toEqual({ access_token: 'AT', refresh_token: 'RT' })
    // creds live in the body, NOT the query string (a failed-request log would leak a query secret).
    expect(ctx.http.post).toHaveBeenCalledWith(
      'https://github.com/login/oauth/access_token',
      { client_id: 'cid', client_secret: 'csec', code: 'C', state: 'S', redirect_uri: 'R' },
      { headers: { accept: 'application/json' } }
    )
  })

  it('retries once on a network-layer failure (no response), then succeeds', async () => {
    vi.useFakeTimers()
    try {
      const ctx = makeCtx()
      ctx.http.post
        .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
        }))
        .mockResolvedValueOnce({ access_token: 'AT', refresh_token: 'RT' })
      const http = new GitHubHttp(ctx, config)
      const p = http.getTokens({ code: 'C' })
      await vi.runAllTimersAsync() // advance the backoff without real waiting
      expect(await p).toEqual({ access_token: 'AT', refresh_token: 'RT' })
      expect(ctx.http.post).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry a real HTTP error (has response)', async () => {
    const ctx = makeCtx()
    ctx.http.post.mockRejectedValue({ response: { status: 400, data: { message: 'bad_verification_code' } } })
    const http = new GitHubHttp(ctx, config)
    await expect(http.getTokens({ code: 'C' })).rejects.toMatchObject({ response: { status: 400 } })
    expect(ctx.http.post).toHaveBeenCalledTimes(1)
  })
})

describe('createWebhook', () => {
  it('POSTs /repos/{repo}/hooks with events:[*] + config.url/secret + auth header', async () => {
    const ctx = makeCtx()
    ctx.http.post.mockResolvedValue({ id: 42 })
    const http = new GitHubHttp(ctx, config)
    const out = await http.createWebhook(user(), 'org/repo', {
      secret: 'sek', callbackUrl: 'https://sili.example/api/github/webhook',
    })
    expect(out).toEqual({ id: 42 })
    expect(ctx.http.post).toHaveBeenCalledWith(
      'https://api.github.com/repos/org/repo/hooks',
      { events: ['*'], config: { url: 'https://sili.example/api/github/webhook', secret: 'sek' } },
      { headers: { authorization: 'token at0', accept: 'application/vnd.github.v3+json' } }
    )
  })

  it('on 401 refreshes the token, persists it, and retries the call', async () => {
    const ctx = makeCtx()
    // getTokens (refresh) result:
    ctx.http.post
      .mockRejectedValueOnce({ response: { status: 401 } }) // first createWebhook call
      .mockResolvedValueOnce({ access_token: 'AT2', refresh_token: 'RT2' }) // refresh getTokens
      .mockResolvedValueOnce({ id: 99 }) // retried createWebhook
    const http = new GitHubHttp(ctx, config)
    const u = user()
    const out = await http.createWebhook(u, 'org/repo', { secret: 's', callbackUrl: 'cb' })
    expect(out).toEqual({ id: 99 })
    // refresh persisted to db + mutated the in-memory user
    expect(ctx.database.set).toHaveBeenCalledWith('user', { id: 7 }, {
      'github.accessToken': 'AT2', 'github.refreshToken': 'RT2',
    })
    expect(u.github.accessToken).toBe('AT2')
    // retried with the new token
    expect(ctx.http.post).toHaveBeenLastCalledWith(
      'https://api.github.com/repos/org/repo/hooks',
      expect.anything(),
      { headers: { authorization: 'token AT2', accept: 'application/vnd.github.v3+json' } }
    )
  })

  it('non-401 errors propagate', async () => {
    const ctx = makeCtx()
    ctx.http.post.mockRejectedValue({ response: { status: 404 } })
    const http = new GitHubHttp(ctx, config)
    await expect(http.createWebhook(user(), 'org/repo', { secret: 's', callbackUrl: 'cb' }))
      .rejects.toMatchObject({ response: { status: 404 } })
  })
})

describe('getUser', () => {
  it('GETs /user with the token auth header and returns the profile', async () => {
    const ctx = makeCtx()
    ctx.http.get.mockResolvedValue({ login: 'octocat', id: 1 })
    const http = new GitHubHttp(ctx, config)
    const out = await http.getUser('AT')
    expect(out).toEqual({ login: 'octocat', id: 1 })
    expect(ctx.http.get).toHaveBeenCalledWith('https://api.github.com/user', {
      headers: { authorization: 'token AT', accept: 'application/vnd.github.v3+json' },
    })
  })
})

describe('deleteWebhook', () => {
  it('DELETEs /repos/{repo}/hooks/{id} with auth header', async () => {
    const ctx = makeCtx()
    ctx.http.delete.mockResolvedValue(undefined)
    const http = new GitHubHttp(ctx, config)
    await http.deleteWebhook(user(), 'org/repo', 42)
    expect(ctx.http.delete).toHaveBeenCalledWith(
      'https://api.github.com/repos/org/repo/hooks/42',
      { headers: { authorization: 'token at0', accept: 'application/vnd.github.v3+json' } }
    )
  })
  it('swallows a 404 (hook already gone)', async () => {
    const ctx = makeCtx()
    ctx.http.delete.mockRejectedValue({ response: { status: 404 } })
    const http = new GitHubHttp(ctx, config)
    await expect(http.deleteWebhook(user(), 'org/repo', 42)).resolves.toBeUndefined()
  })
})

describe('request (generic authed)', () => {
  it('calls ctx.http(method, url, {data, headers}) with the auth header; extra headers merge over it', async () => {
    const ctx = makeCtx()
    ctx.http.mockResolvedValue({ ok: 1 })
    const http = new GitHubHttp(ctx, config)
    const out = await http.request(user(), 'POST', 'https://api.github.com/x', { a: 1 }, { accept: 'custom' })
    expect(out).toEqual({ ok: 1 })
    expect(ctx.http).toHaveBeenCalledWith('POST', 'https://api.github.com/x', {
      data: { a: 1 },
      headers: { authorization: 'token at0', accept: 'custom' },
    })
  })

  it('refreshes the token on 401 and retries (via withAuth)', async () => {
    const ctx = makeCtx()
    ctx.http
      .mockRejectedValueOnce({ response: { status: 401 } }) // first request
      .mockResolvedValueOnce({ id: 9 }) // retried request
    ctx.http.post.mockResolvedValueOnce({ access_token: 'AT2', refresh_token: 'RT2' }) // refresh getTokens
    const http = new GitHubHttp(ctx, config)
    const u = user()
    const out = await http.request(u, 'PUT', 'https://api.github.com/y')
    expect(out).toEqual({ id: 9 })
    expect(u.github.accessToken).toBe('AT2')
  })
})
