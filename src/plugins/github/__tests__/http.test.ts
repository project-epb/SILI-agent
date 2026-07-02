import { describe, it, expect, vi } from 'vitest'
import { GitHubHttp, type GitHubUser } from '../http'

// Minimal fake koishi Context: only the surface GitHubHttp touches.
function makeCtx(overrides: any = {}) {
  return {
    http: { post: vi.fn(), delete: vi.fn(), get: vi.fn() },
    database: { set: vi.fn().mockResolvedValue(undefined) },
    server: { config: { selfUrl: 'https://sili.example' } },
    ...overrides,
  } as any
}
const config = { appId: 'cid', appSecret: 'csec', path: '/api/github' } as any
const user = (): GitHubUser => ({ id: 7, github: { accessToken: 'at0', refreshToken: 'rt0' } })

describe('getTokens', () => {
  it('posts to the access_token endpoint with client creds + params as query, Accept json', async () => {
    const ctx = makeCtx()
    ctx.http.post.mockResolvedValue({ access_token: 'AT', refresh_token: 'RT' })
    const http = new GitHubHttp(ctx, config)
    const out = await http.getTokens({ code: 'C', state: 'S', redirect_uri: 'R' })
    expect(out).toEqual({ access_token: 'AT', refresh_token: 'RT' })
    expect(ctx.http.post).toHaveBeenCalledWith(
      'https://github.com/login/oauth/access_token',
      {},
      {
        params: { client_id: 'cid', client_secret: 'csec', code: 'C', state: 'S', redirect_uri: 'R' },
        headers: { accept: 'application/json' },
      }
    )
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
