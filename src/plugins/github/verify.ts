import { verify } from '@octokit/webhooks-methods'

/**
 * Validate a GitHub webhook signature against the RAW request body as received
 * (bytes on the wire). Never pass a re-serialized/parsed body — the HMAC would
 * not match GitHub's signature. See root-cause-verified.md.
 */
export async function isSignatureValid(
  secret: string,
  rawBody: string | undefined,
  signature: string | undefined
): Promise<boolean> {
  if (!secret || !rawBody || !signature) return false
  return verify(secret, rawBody, signature)
}
