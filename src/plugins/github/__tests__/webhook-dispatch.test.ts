import { createHmac } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { handleWebhook, type WebhookDeps } from '../webhook'

const secret = 's3cr3t'
const deps: WebhookDeps = { getSecret: async () => secret, targets: () => ['mock:1'] }

// Build a signed urlencoded request for a given event + payload object.
function sign(event: string, payloadObj: any) {
  const json = JSON.stringify(payloadObj)
  const raw = 'payload=' + encodeURIComponent(json)
  const headers = {
    'x-github-event': event,
    'x-github-hook-id': '1',
    'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex'),
  }
  return { raw, body: { payload: json }, headers }
}

describe('handleWebhook dispatch for non-push events', () => {
  it('routes an issues/opened event to renderIssues', async () => {
    const { raw, body, headers } = sign('issues', {
      action: 'opened',
      repository: { full_name: 'org/repo' },
      sender: { login: 'alice' },
      issue: { number: 3, title: 'Bug', body: 'boom', user: { type: 'User' } },
    })
    const r = await handleWebhook(headers, raw, body, deps)
    expect(r.status).toBe(200)
    expect(r.targets).toEqual(['mock:1'])
    expect(r.message).toBe('alice opened an issue org/repo#3\nTitle: Bug\nboom')
  })

  it('applies bodyMaxLength truncation via renderOptions', async () => {
    const { raw, body, headers } = sign('issues', {
      action: 'opened',
      repository: { full_name: 'org/repo' },
      sender: { login: 'alice' },
      issue: { number: 3, title: 'T', body: 'abcdefghij', user: { type: 'User' } },
    })
    const r = await handleWebhook(headers, raw, body, deps, { bodyMaxLength: 3 })
    expect(r.message).toBe('alice opened an issue org/repo#3\nTitle: T\nabc…')
  })

  it('a subscribed but unrendered event (e.g. gollum) yields 200 with no message', async () => {
    const { raw, body, headers } = sign('gollum', {
      repository: { full_name: 'org/repo' }, sender: { login: 'alice' },
    })
    const r = await handleWebhook(headers, raw, body, deps)
    expect(r.status).toBe(200)
    expect(r.message).toBeUndefined()
  })
})
