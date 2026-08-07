import { createHmac } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { handleWebhook, type WebhookDeps } from '../webhook'
import { buildActions } from '../actions'

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

/** Build the {headers, raw, body} triple for an arbitrary payload, correctly signed. */
const delivery = (event: string, payloadObj: any) => {
  const json = JSON.stringify(payloadObj)
  const raw = 'payload=' + encodeURIComponent(json)
  return {
    headers: headers({
      'x-github-event': event,
      'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex'),
    }),
    raw,
    body: { payload: json },
  }
}

const deps: WebhookDeps = {
  getHook: async (id) => (id === 42 ? { name: 'org/repo', secret } : undefined),
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

  describe('bot filtering', () => {
    // A branch created by renovate — the event class that used to escape every hardcoded
    // bot check and spam the channel once per opened PR.
    const botCreate = delivery('create', {
      repository: { full_name: 'Org/Repo' },
      ref: 'renovate/lodash-4.x',
      ref_type: 'branch',
      sender: { type: 'Bot', login: 'renovate[bot]' },
    })

    it('drops an event from a bot sender when enabled', async () => {
      const r = await handleWebhook(botCreate.headers, botCreate.raw, botCreate.body, deps, undefined, {
        enabled: true,
        extraLogins: [],
      })
      expect(r.status).toBe(200)
      expect(r.targets).toBeUndefined()
      expect(r.filtered).toBe('bot')
    })

    it('delivers the same event when filtering is disabled', async () => {
      const r = await handleWebhook(botCreate.headers, botCreate.raw, botCreate.body, deps, undefined, {
        enabled: false,
        extraLogins: [],
      })
      expect(r.status).toBe(200)
      expect(r.targets).toEqual(['mock:1'])
      expect(r.filtered).toBeUndefined()
    })

    it('drops an event from a listed automation running as a plain user', async () => {
      const d = delivery('create', {
        repository: { full_name: 'Org/Repo' },
        ref: 'renovate/lodash-4.x',
        ref_type: 'branch',
        sender: { type: 'User', login: 'renovate-bot' },
      })
      const r = await handleWebhook(d.headers, d.raw, d.body, deps, undefined, {
        enabled: true,
        extraLogins: ['renovate-bot'],
      })
      expect(r.filtered).toBe('bot')
      expect(r.targets).toBeUndefined()
    })

    it('delivers a human event while filtering is enabled', async () => {
      const r = await handleWebhook(headers(), raw, body, deps, undefined, {
        enabled: true,
        extraLogins: ['renovate-bot'],
      })
      expect(r.targets).toEqual(['mock:1'])
      expect(r.filtered).toBeUndefined()
    })

    it('rejects a forged bot-filtered delivery before the signature is checked', async () => {
      // Filtering must never become an early-exit that skips signature verification.
      const r = await handleWebhook(
        { ...botCreate.headers, 'x-hub-signature-256': 'sha256=bad' },
        botCreate.raw,
        botCreate.body,
        deps,
        undefined,
        { enabled: true, extraLogins: [] }
      )
      expect(r.status).toBe(403)
    })
  })

  describe('escaping', () => {
    // GitHub bodies are attacker-controlled text that koishi would otherwise parse as
    // h-element source: an `<img src=…>` in an issue turns into a real image element,
    // and a broken URL then fails the whole send (retcode 1200 in prod).
    const issuePayload = (body: string) => ({
      repository: { full_name: 'Org/Repo' },
      issue: {
        url: 'https://api.github.com/repos/Org/Repo/issues/1',
        html_url: 'https://github.com/Org/Repo/issues/1',
        comments_url: 'https://api.github.com/repos/Org/Repo/issues/1/comments',
        title: 'a bug',
        number: 1,
        body,
        user: { type: 'User' },
      },
      sender: { login: 'alice' },
      action: 'opened',
    })

    const deliverIssue = async (body: string) => {
      const json = JSON.stringify(issuePayload(body))
      const r = 'payload=' + encodeURIComponent(json)
      return handleWebhook(
        headers({
          'x-github-event': 'issues',
          'x-hub-signature-256':
            'sha256=' + createHmac('sha256', secret).update(r).digest('hex'),
        }),
        r,
        { payload: json },
        deps
      )
    }

    it('escapes markup in the body so it cannot become an element', async () => {
      const res = await deliverIssue('见 <img src="https://nope.invalid/x.png"/> 这里')
      expect(res.message).not.toContain('<img')
      expect(res.message).toContain('&lt;img src="https://nope.invalid/x.png"/&gt;')
    })

    it('escapes an at-element so a body cannot make the bot mention anyone', async () => {
      const res = await deliverIssue('cc <at id="all"/>')
      expect(res.message).not.toContain('<at')
      expect(res.message).toContain('&lt;at id="all"/&gt;')
    })

    it('leaves ordinary text untouched', async () => {
      const res = await deliverIssue('just a normal report')
      expect(res.message).toContain('just a normal report')
      expect(res.message).not.toContain('&')
    })

    it('does NOT escape the quote body — that one goes back to GitHub as markdown', async () => {
      // quoteBody is posted into a GitHub comment, not into a chat message, so HTML
      // entities there would show up literally in the issue thread.
      const res = await deliverIssue('见 <img src="https://nope.invalid/x.png"/> 这里')
      expect(res.quoteBody).toContain('<img src="https://nope.invalid/x.png"/>')
    })
  })

  it('returns quick-reply actions for an interactive event on success', async () => {
    const issuesPayload = {
      repository: { full_name: 'Org/Repo' },
      issue: {
        url: 'https://api.github.com/repos/Org/Repo/issues/1',
        html_url: 'https://github.com/Org/Repo/issues/1',
        comments_url: 'https://api.github.com/repos/Org/Repo/issues/1/comments',
        title: 'a bug',
        number: 1,
        body: 'oops',
        user: { type: 'User' },
      },
      sender: { login: 'alice' },
      action: 'opened',
    }
    const issuesJson = JSON.stringify(issuesPayload)
    const issuesRaw = 'payload=' + encodeURIComponent(issuesJson)
    const issuesSig = 'sha256=' + createHmac('sha256', secret).update(issuesRaw).digest('hex')
    const r = await handleWebhook(
      headers({ 'x-github-event': 'issues', 'x-hub-signature-256': issuesSig }),
      issuesRaw,
      { payload: issuesJson },
      deps
    )
    expect(r.status).toBe(200)
    expect(r.targets).toEqual(['mock:1'])
    expect(r.actions).toEqual(buildActions('issues', issuesPayload))
    // The quote body is the issue body (header line excluded) so a quote-reply prepends `> oops`.
    expect(r.quoteBody).toBe('oops')
  })
})
