import { createHash } from 'node:crypto'

/** Crockford base32: no I, L, O, U. Must match the wiki-side alphabet. */
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

/** Finds `<wiki user id>-<code>` anywhere in the join request text. */
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

export interface WikiUser {
  id: number
  name: string
  /** Explicit and implicit groups (`autoconfirmed` included). */
  groups: string[]
  /** Explicit groups with their expiry: ISO time, or `infinity`. */
  memberships: { group: string; expiry: string }[]
  blocked: boolean
}

export interface VerifySource {
  /** Wiki user by id, or undefined if there is none. */
  user(id: number): Promise<WikiUser | undefined>
  /** Latest revision of the user's verify page, or undefined if missing. */
  verifyPage(
    name: string
  ): Promise<{ content: string; editor: string } | undefined>
  /** Openid that spent this page hash, if any. */
  codeSpentBy(hash: string): Promise<string | undefined>
  /** Wiki user id the applicant is bound to on this wiki, if any. */
  boundTo(openid: string): Promise<number | undefined>
  /** Openids bound to this wiki user on this wiki. */
  boundOpenids(wikiUserId: number): Promise<string[]>
  /** When the user last gained this group (ms), from the rights log. */
  groupAddedAt(name: string, group: string): Promise<number | undefined>
}

export interface Policy {
  /** Site name shown in reasons, e.g. 萌娘百科. */
  label: string
  /** The applicant must be in one of these groups; empty means any account. */
  groups: string[]
  /** A temporary membership counts only once held this many days. */
  tempMinDays?: number
}

/** A binding to write: `hash` is the code to spend, absent when reusing one. */
export interface Bind {
  wikiUserId: number
  wikiUserName: string
  hash?: string
}

export type Decision =
  | { ok: true; user: WikiUser; bind?: Bind }
  | { ok: false; reason: string; user?: Pick<WikiUser, 'id' | 'name'> }

type CodeCheck =
  | { ok: true; user: WikiUser; hash: string; spent: boolean }
  | { ok: false; reason: string; user?: WikiUser }

/**
 * Checks the code in an answer. `ignoreTtl` is for admins approving by hand:
 * the page hash still proves the account even after the code expired.
 * Errors thrown by `source` propagate: the caller reports them verbatim.
 */
async function checkCode(
  content: string,
  applicant: string,
  source: VerifySource,
  policy: Policy,
  now: number,
  ignoreTtl: boolean
): Promise<CodeCheck> {
  const answer = parseAnswer(content)
  if (!answer)
    return { ok: false, reason: '答案里没有验证码，可能没在 wiki 上做验证' }

  const user = await source.user(answer.wikiUserId)
  if (!user)
    return { ok: false, reason: `答案里的${policy.label}用户 ID 不存在` }
  const fail = (reason: string): CodeCheck => ({ ok: false, reason, user })

  const page = await source.verifyPage(user.name)
  if (!page) return fail(`${policy.label}账号「${user.name}」还没生成验证码`)
  if (!sameUser(page.editor, user.name))
    return fail(`「${user.name}」的验证页最后不是本人编辑的`)

  const record = parseRecord(page.content)
  const mismatch = `验证码和「${user.name}」的验证页对不上`
  if (!record) return fail(mismatch)
  if (!ignoreTtl && now - record.time > CODE_TTL)
    return fail('验证码已过期（有效期 2 小时）')
  if (sha1(`${record.time}#${answer.code}`) !== record.hash)
    return fail(mismatch)

  const spentBy = await source.codeSpentBy(record.hash)
  if (spentBy && spentBy !== applicant) return fail('这个验证码已经用过了')
  return { ok: true, user, hash: record.hash, spent: !!spentBy }
}

const DAY = 24 * 60 * 60 * 1000

/** Membership and block state of the account the applicant joins as. */
async function admit(
  user: WikiUser,
  policy: Policy,
  source: VerifySource,
  now: number,
  bind?: Bind
): Promise<Decision> {
  const who = { id: user.id, name: user.name }
  const fail = (reason: string): Decision => ({ ok: false, reason, user: who })
  if (user.blocked) return fail(`「${user.name}」当前处于封禁状态`)
  if (!policy.groups.length) return { ok: true, user, bind }

  const held = policy.groups.filter((g) => user.groups.includes(g))
  if (!held.length)
    return fail(
      `「${user.name}」不满足本群要求（需要以下用户组之一：${policy.groups.join('、')}）`
    )
  if (!policy.tempMinDays) return { ok: true, user, bind }

  // Permanent (or implicit) membership admits at once; a temporary one only
  // after it has been held tempMinDays since it was granted.
  for (const group of held) {
    const membership = user.memberships.find((m) => m.group === group)
    if (!membership || membership.expiry === 'infinity')
      return { ok: true, user, bind }
    const since = await source.groupAddedAt(user.name, group)
    if (since !== undefined && now - since >= policy.tempMinDays * DAY)
      return { ok: true, user, bind }
  }
  return fail(
    `「${user.name}」的临时用户组（${held.join('、')}）持有不足 ${policy.tempMinDays} 天`
  )
}

/**
 * Decides an incoming join request.
 * - A valid code binds its account to the applicant (switching any earlier
 *   binding of this QQ), except when the account is already bound to another
 *   QQ: that first extra QQ goes to a human.
 * - Without a valid code, an existing binding stands in for it.
 * - The group's requirements are then checked against the live account.
 */
export async function decide(
  content: string,
  applicant: string,
  source: VerifySource,
  policy: Policy,
  now = Date.now()
): Promise<Decision> {
  const code = await checkCode(content, applicant, source, policy, now, false)
  if (!('reason' in code)) {
    const { user, hash, spent } = code
    const bind: Bind = {
      wikiUserId: user.id,
      wikiUserName: user.name,
      ...(spent ? {} : { hash }),
    }
    if ((await source.boundTo(applicant)) !== user.id) {
      const others = await source.boundOpenids(user.id)
      if (others.some((id) => id !== applicant))
        return {
          ok: false,
          reason: `${policy.label}账号「${user.name}」已绑定另一个 QQ，请确认不是盗用`,
          user: { id: user.id, name: user.name },
        }
    }
    return admit(user, policy, source, now, bind)
  }

  const boundId = await source.boundTo(applicant)
  if (boundId === undefined)
    return {
      ok: false,
      reason: code.reason,
      user: code.user && { id: code.user.id, name: code.user.name },
    }
  const bound = await source.user(boundId)
  if (!bound)
    return {
      ok: false,
      reason: `已绑定的${policy.label}账号（ID ${boundId}）不存在了`,
    }
  return admit(bound, policy, source, now)
}

/**
 * What an admin's manual approval binds: the answer's account when its code
 * matches the page (expired is fine) and nobody else spent it.
 */
export async function bindOnApproval(
  content: string,
  applicant: string,
  source: VerifySource,
  policy: Policy
): Promise<Bind | undefined> {
  const code = await checkCode(content, applicant, source, policy, 0, true)
  if ('reason' in code) return
  return {
    wikiUserId: code.user.id,
    wikiUserName: code.user.name,
    ...(code.spent ? {} : { hash: code.hash }),
  }
}

/**
 * One pending request per applicant: the latest. QQ lists every application,
 * and one person can apply or be invited again before the first is handled;
 * their rows would share a button id and QQ rejects the whole keyboard
 * (40011021 rows.buttons.id 无效), and their short ids would match twice.
 */
export function latestPerMember<
  T extends { member_openid: string; apply_at: string },
>(list: T[]): T[] {
  const latest = new Map<string, T>()
  for (const item of list) {
    const kept = latest.get(item.member_openid)
    if (!kept || Date.parse(item.apply_at) >= Date.parse(kept.apply_at))
      latest.set(item.member_openid, item)
  }
  return list.filter((item) => latest.get(item.member_openid) === item)
}
