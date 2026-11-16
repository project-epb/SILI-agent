import { createHash } from 'node:crypto'

/** Crockford base32: no I, L, O, U. Must match the gadget's alphabet. */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const CODE_LENGTH = 16
export const CODE_TTL = 2 * 60 * 60 * 1000

const ANSWER_RE = new RegExp(
  `(\\d{1,12})\\s*-\\s*([0-9A-Za-z]{${CODE_LENGTH}})`
)

export interface Answer {
  wikiUserId: number
  code: string
}

/** Finds `<Fandom user id>-<code>` anywhere in the join request text. */
export function parseAnswer(content: string): Answer | undefined {
  const match = ANSWER_RE.exec(content)
  if (!match) return
  const code = match[2].toUpperCase()
  if ([...code].some((char) => !CODE_ALPHABET.includes(char))) return
  return { wikiUserId: Number(match[1]), code }
}

/** The page holds `<timestamp>#<sha1(timestamp#code)>`. */
export function parseRecord(text: string) {
  const [time, hash, ...rest] = text.trim().split('#')
  if (rest.length || !/^\d+$/.test(time) || !/^[0-9a-f]{40}$/.test(hash)) return
  return { time: Number(time), hash }
}

export function sha1(text: string) {
  return createHash('sha1').update(text).digest('hex')
}

/** Wiki user names compare with spaces and underscores folded. */
export function sameUser(a: string, b: string) {
  const norm = (name: string) => name.replace(/[\s_]+/g, '_').trim()
  return norm(a) === norm(b)
}

export interface VerifySource {
  /** Current name of a Fandom user id, or undefined if there is none. */
  userName(id: number): Promise<string | undefined>
  /** Latest revision of `User:<name>/qq-hash`, or undefined if missing. */
  verifyPage(
    name: string
  ): Promise<{ content: string; editor: string } | undefined>
  /** Whether this page hash already let someone in. */
  isUsed(hash: string): Promise<boolean>
}

export type VerifyResult =
  | { ok: true; wikiUserId: number; wikiUserName: string; hash: string }
  | { ok: false; reason: string; wikiUserName?: string }

/** Errors thrown by `source` propagate: the caller reports them verbatim. */
export async function verifyAnswer(
  content: string,
  source: VerifySource,
  now = Date.now()
): Promise<VerifyResult> {
  const answer = parseAnswer(content)
  if (!answer)
    return { ok: false, reason: '答案里没有验证码，可能没在 wiki 上做验证' }

  const name = await source.userName(answer.wikiUserId)
  if (!name) return { ok: false, reason: '答案里的 Fandom 用户 ID 不存在' }
  const fail = (reason: string): VerifyResult => ({
    ok: false,
    reason,
    wikiUserName: name,
  })

  const page = await source.verifyPage(name)
  if (!page) return fail(`Fandom 账号「${name}」还没生成验证码`)
  if (!sameUser(page.editor, name))
    return fail(`「${name}」的验证页最后不是本人编辑的`)

  const record = parseRecord(page.content)
  const mismatch = `验证码和「${name}」的验证页对不上`
  if (!record) return fail(mismatch)
  if (now - record.time > CODE_TTL) return fail('验证码已过期（有效期 2 小时）')
  if (sha1(`${record.time}#${answer.code}`) !== record.hash)
    return fail(mismatch)
  if (await source.isUsed(record.hash)) return fail('这个验证码已经用过了')

  return {
    ok: true,
    wikiUserId: answer.wikiUserId,
    wikiUserName: name,
    hash: record.hash,
  }
}
