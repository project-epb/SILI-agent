import { describe, it, expect, vi } from 'vitest'

// koishi 包顶层会拉 loader 等运行时副作用，在 vitest 下加载失败；oauth.ts 只在
// applyOAuth 里用到 Context/Random，被测的三个纯函数完全不碰它们，全 stub 即可。
vi.mock('koishi', () => ({
  Context: class {},
  Random: { id: () => 'stub-state' },
}))

import { handleOAuthCallback, buildAuthorizeUrl, renderCallbackPage } from '../oauth'

describe('handleOAuthCallback', () => {
  const tokens = { access_token: 'AT', refresh_token: 'RT' }
  const makeDeps = () => ({
    consumeState: vi.fn((s: string) => (s === 'good' ? 7 : undefined)),
    exchangeCode: vi.fn().mockResolvedValue(tokens),
    storeTokens: vi.fn().mockResolvedValue(undefined),
  })

  it('400 when state is missing', async () => {
    const deps = makeDeps()
    expect(await handleOAuthCallback({ code: 'c' }, deps)).toBe(400)
    expect(deps.exchangeCode).not.toHaveBeenCalled()
  })
  it('400 when state is an array (duplicate query param)', async () => {
    expect(await handleOAuthCallback({ state: ['a', 'b'], code: 'c' }, makeDeps())).toBe(400)
  })
  it('403 when state is unknown', async () => {
    const deps = makeDeps()
    expect(await handleOAuthCallback({ state: 'bad', code: 'c' }, deps)).toBe(403)
    expect(deps.exchangeCode).not.toHaveBeenCalled()
  })
  it('200 exchanges the code and stores tokens for the mapped user', async () => {
    const deps = makeDeps()
    expect(await handleOAuthCallback({ state: 'good', code: 'CODE' }, deps)).toBe(200)
    expect(deps.exchangeCode).toHaveBeenCalledWith('CODE', 'good')
    expect(deps.storeTokens).toHaveBeenCalledWith(7, tokens)
  })
})

describe('buildAuthorizeUrl', () => {
  it('includes client_id, state, redirect_uri, and the repo-hook scope', () => {
    const url = buildAuthorizeUrl('CID', 'https://sili.example/api/github/authorize', 'ST')
    expect(url).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/)
    const q = new URL(url).searchParams
    expect(q.get('client_id')).toBe('CID')
    expect(q.get('state')).toBe('ST')
    expect(q.get('redirect_uri')).toBe('https://sili.example/api/github/authorize')
    expect(q.get('scope')).toBe('admin:repo_hook,repo')
  })
})

describe('renderCallbackPage', () => {
  it('renders a success page for 200 with the safe-to-close message', () => {
    const html = renderCallbackPage(200)
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('绑定成功')
    expect(html).toContain('你现在可以安全地关闭此网页。')
  })
  it('renders a failure page for non-200 statuses', () => {
    for (const s of [400, 403]) {
      const html = renderCallbackPage(s)
      expect(html).toContain('<!DOCTYPE html>')
      expect(html).toContain('授权失败')
      expect(html).not.toContain('绑定成功')
    }
  })
})
