import { describe, it, expect, vi } from 'vitest'
vi.mock('koishi', () => ({ Context: class {}, Random: { id: () => 'stub' } }))
import { parseReplyCommand, formatHelp, buildQuotedComment, INDICATOR, ReplyHandler } from '../reply'
import { buildQuoteBody } from '../actions'

describe('parseReplyCommand', () => {
  it('treats .help / help / !help / /help (any case) as help', () => {
    for (const b of ['.help', 'help', '!help', '/help', 'HELP', '.Help']) {
      expect(parseReplyCommand(b)).toEqual({ name: 'help', message: '' })
    }
  })
  it('dot-prefixed → explicit action name + trailing message', () => {
    expect(parseReplyCommand('.close 修好了')).toEqual({ name: 'close', message: '修好了' })
    expect(parseReplyCommand('.link')).toEqual({ name: 'link', message: '' })
    expect(parseReplyCommand('.merge feat: x')).toEqual({ name: 'merge', message: 'feat: x' })
  })
  it('bare emoji name → react', () => {
    expect(parseReplyCommand('+1')).toEqual({ name: 'react', message: '+1' })
    expect(parseReplyCommand('rocket')).toEqual({ name: 'react', message: 'rocket' })
  })
  it('any other bare text → reply (default)', () => {
    expect(parseReplyCommand('说得好')).toEqual({ name: 'reply', message: '说得好' })
    expect(parseReplyCommand('help我看看')).toEqual({ name: 'reply', message: 'help我看看' })
  })
})

describe('formatHelp', () => {
  it('lists only the supported actions with descriptions', () => {
    const out = formatHelp(['close', 'link', 'react', 'reply'])
    expect(out).toContain('.reply')
    expect(out).toContain('.close')
    expect(out).not.toContain('.merge')
  })
})

describe('buildQuotedComment', () => {
  it('prefixes the quoted original per line, then reply, then INDICATOR + footer', () => {
    const out = buildQuotedComment('alice commented\nbody line', '+1 说得好', 'FOOTER')
    expect(out).toBe('> alice commented\n> body line\n\n+1 说得好\n\n' + INDICATOR + '\nFOOTER')
  })
  it('nested quotes accumulate ( > x → > > x )', () => {
    const out = buildQuotedComment('> earlier', 'ok', '')
    expect(out.split('\n')[0]).toBe('> > earlier')
  })
  it('empty quoted → reply + INDICATOR only', () => {
    expect(buildQuotedComment('', 'hi', '')).toBe('hi\n\n' + INDICATOR)
  })
  it('empty footer → no trailing footer line', () => {
    const out = buildQuotedComment('q', 'r', '')
    expect(out.endsWith(INDICATOR)).toBe(true)
  })
  it('a blank quoted line becomes a bare ">" (no trailing space)', () => {
    // '> a\n\n> b' has an empty middle line; it must quote to '>' not '> '.
    const out = buildQuotedComment('> a\n\n> b', 'r', '')
    expect(out.split('\n\n')[0]).toBe('> > a\n>\n> > b')
  })
})

// Full quote-reply round-trip: buildQuotedComment posts a body to GitHub, GitHub echoes it
// back as the next comment.body, buildQuoteBody cleans it into the next quotedText. Blank-line
// separators between nested quote levels must survive so the rendered markdown stays nested.
describe('nested quote round-trip', () => {
  const opts = { bodyMaxLength: 500 }
  const round = (quoted: string, reply: string) => {
    const body = buildQuotedComment(quoted, reply, '')
    const next = buildQuoteBody('issue_comment', { comment: { body } }, opts)
    return { body, next }
  }

  it('keeps a blank separator at every level after three rounds', () => {
    const r1 = round('from github', 'from qq')
    const r2 = round(r1.next, '多重引用')
    const r3 = round(r2.next, '继续引用')
    expect(r3.body).toBe(
      ['> > > from github', '> >', '> > from qq', '>', '> 多重引用', '', '继续引用', '', INDICATOR].join('\n')
    )
  })
})

function makeHandler(content: string, quotedText = 'Q', footer = 'F') {
  const request = vi.fn().mockResolvedValue(undefined)
  const ctx = { logger: () => ({ warn: vi.fn() }) } as any
  const http = { request } as any
  const user = { id: 7, github: { accessToken: 'at', refreshToken: 'rt' } }
  return { handler: new ReplyHandler(ctx, http, user, content, quotedText, footer), request, user }
}

describe('ReplyHandler', () => {
  it('link returns the url (no network)', async () => {
    const { handler, request } = makeHandler('')
    expect(await handler.link('https://x')).toBe('https://x')
    expect(request).not.toHaveBeenCalled()
  })

  it('react POSTs the emoji with the squirrel-girl accept header', async () => {
    const { handler, request, user } = makeHandler('+1')
    await handler.react('https://api/react')
    expect(request).toHaveBeenCalledWith(user, 'POST', 'https://api/react', { content: '+1' }, {
      accept: 'application/vnd.github.squirrel-girl-preview',
    })
  })

  it('react rejects an unknown emoji without calling the api', async () => {
    const { handler, request } = makeHandler('thumbsup')
    const out = await handler.react('https://api/react')
    expect(out).toContain('reaction')
    expect(request).not.toHaveBeenCalled()
  })

  it('reply POSTs a quoted comment body', async () => {
    const { handler, request, user } = makeHandler('好的', 'alice commented', 'F')
    await handler.reply('https://api/comments')
    expect(request).toHaveBeenCalledWith(user, 'POST', 'https://api/comments', {
      body: '> alice commented\n\n好的\n\n<!-- BOT-MESSAGE-FOOTER -->\nF',
    })
  })

  it('reply threads extra params (commit_comment path/position)', async () => {
    const { handler, request } = makeHandler('r', 'q', '')
    await handler.reply('https://api/x', { path: 'a.ts', position: 3 })
    expect(request.mock.calls[0][3]).toMatchObject({ path: 'a.ts', position: 3 })
  })

  it('close with content comments first, then PATCHes state=closed', async () => {
    const { handler, request } = makeHandler('done', 'q', '')
    await handler.close('https://api/i', 'https://api/i/comments')
    expect(request.mock.calls[0].slice(1, 3)).toEqual(['POST', 'https://api/i/comments'])
    expect(request.mock.calls[1].slice(1)).toEqual(['PATCH', 'https://api/i', { state: 'closed' }])
  })

  it('close without content only PATCHes', async () => {
    const { handler, request } = makeHandler('', 'q', '')
    await handler.close('https://api/i', 'https://api/i/comments')
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0].slice(1)).toEqual(['PATCH', 'https://api/i', { state: 'closed' }])
  })

  it('merge splits content into commit_title (first line) + commit_message (rest)', async () => {
    const { handler, request, user } = makeHandler('feat: title\nlong body', 'q', '')
    await handler.merge('https://api/pr/merge')
    expect(request).toHaveBeenCalledWith(user, 'PUT', 'https://api/pr/merge', {
      merge_method: 'merge',
      commit_title: 'feat: title',
      commit_message: 'long body',
    })
  })

  it('rebase/squash pass the merge_method', async () => {
    const a = makeHandler('t', 'q', ''); await a.handler.rebase('https://api/pr/merge')
    expect(a.request.mock.calls[0][3]).toMatchObject({ merge_method: 'rebase' })
    const b = makeHandler('t', 'q', ''); await b.handler.squash('https://api/pr/merge')
    expect(b.request.mock.calls[0][3]).toMatchObject({ merge_method: 'squash' })
  })

  it('base PATCHes the base branch', async () => {
    const { handler, request, user } = makeHandler('main', 'q', '')
    await handler.base('https://api/pr')
    expect(request).toHaveBeenCalledWith(user, 'PATCH', 'https://api/pr', { base: 'main' })
  })

  it('on api failure returns a hint with the http detail', async () => {
    const request = vi.fn().mockRejectedValue({ response: { status: 422, data: { message: 'Unprocessable' } } })
    const ctx = { logger: () => ({ warn: vi.fn() }) } as any
    const user = { id: 7, github: { accessToken: 'at', refreshToken: 'rt' } }
    const handler = new ReplyHandler(ctx, { request } as any, user, '好', 'q', '')
    const out = await handler.reply('https://api/x')
    expect(out).toContain('HTTP 422: Unprocessable')
  })
})
