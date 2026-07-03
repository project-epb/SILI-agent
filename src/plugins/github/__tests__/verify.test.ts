import { createHmac } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { isSignatureValid } from '../verify'

const sign = (secret: string, raw: string) =>
  'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')

describe('isSignatureValid', () => {
  const secret = 's3cr3t'
  const json = JSON.stringify({ zen: 'Keep it simple.' })
  // GitHub default content-type: x-www-form-urlencoded, raw body = "payload=<urlencoded json>"
  const raw = 'payload=' + encodeURIComponent(json)

  it('accepts a correct signature over the raw urlencoded body', async () => {
    expect(await isSignatureValid(secret, raw, sign(secret, raw))).toBe(true)
  })

  it('rejects a tampered body', async () => {
    expect(await isSignatureValid(secret, raw + 'x', sign(secret, raw))).toBe(false)
  })

  // Regression: the OLD bug signed re-serialized JSON instead of the raw body. Keep it dead.
  it('rejects a signature computed over re-serialized JSON, not the raw body', async () => {
    expect(await isSignatureValid(secret, raw, sign(secret, json))).toBe(false)
  })

  it('rejects when secret / body / signature are missing', async () => {
    expect(await isSignatureValid('', raw, sign(secret, raw))).toBe(false)
    expect(await isSignatureValid(secret, undefined, sign(secret, raw))).toBe(false)
    expect(await isSignatureValid(secret, raw, undefined)).toBe(false)
  })
})
