import { describe, expect, it } from 'vitest'

import { DsmlLeakUnrecoverableError } from '../agent-loop'
import { describeChatError } from '../utils/chat-error'

const api = (name: string, status: number | undefined, message: string) => Object.assign(new Error(message), { name, status })

describe('describeChatError', () => {
  it.each([
    [new DsmlLeakUnrecoverableError(2), 'DSML'],
    [new Error('Tool call JSON parse failed for x: {'), 'JSON'],
    [api('APIConnectionTimeoutError', undefined, 'Request timed out.'), '超时'],
    [api('APIConnectionError', undefined, 'Connection error.'), '网络中断'],
    [api('AuthenticationError', 401, 'bad key'), 'HTTP 401'],
    [api('RateLimitError', 429, 'slow down'), 'HTTP 429'],
    [api('BadRequestError', 400, "This model's maximum context length is 128000 tokens"), '记不下'],
    [api('InternalServerError', 502, 'bad gateway'), 'HTTP 502'],
    [api('BadRequestError', 400, "'file' field is required"), "'file' field is required"],
  ])('%s', (e, expected) => {
    expect(describeChatError(e)).toContain(expected)
  })
})
