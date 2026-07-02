import { createHmac } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { handleWebhook, type WebhookDeps } from '../webhook'

const secret = 's3cr3t'
const payloadObj = {
  repository: { full_name: 'Org/Repo' },
  pusher: { name: 'alice' },
  sender: { type: 'User' },
  ref: 'refs/heads/main',
  before: 'a'.repeat(40),
  after: 'b'.repeat(40),
  commits: [{ id: 'abcdef1', message: 'msg' }],
}
const json = JSON.stringify(payloadObj)
const raw = 'payload=' + encodeURIComponent(json)
const body = { payload: json }
const sig = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')

const headers = (extra: Record<string, any> = {}) => ({
  'x-github-event': 'push',
  'x-github-hook-id': '42',
  'x-hub-signature-256': sig,
  ...extra,
})

const deps: WebhookDeps = {
  getSecret: async (id) => (id === 42 ? secret : undefined),
  targets: () => ['mock:1'],
}

describe('handleWebhook', () => {
  it('200 + targets + message on a valid push', async () => {
    const r = await handleWebhook(headers(), raw, body, deps)
    expect(r.status).toBe(200)
    expect(r.targets).toEqual(['mock:1'])
    expect(r.message).toBe('alice pushed to Org/Repo:main\n[abcdef] msg')
  })
  it('403 on a bad signature', async () => {
    const r = await handleWebhook(headers({ 'x-hub-signature-256': 'sha256=bad' }), raw, body, deps)
    expect(r.status).toBe(403)
  })
  it('202 on an unknown hook id (no stored secret)', async () => {
    const r = await handleWebhook(headers({ 'x-github-hook-id': '999' }), raw, body, deps)
    expect(r.status).toBe(202)
  })
  it('400 when the payload cannot be parsed', async () => {
    const r = await handleWebhook(headers(), 'payload=oops', { payload: 'oops{' }, deps)
    expect(r.status).toBe(400)
  })
  it('200 with no targets when nobody is subscribed', async () => {
    const r = await handleWebhook(headers(), raw, body, { ...deps, targets: () => [] })
    expect(r.status).toBe(200)
    expect(r.targets ?? []).toEqual([])
  })
})
