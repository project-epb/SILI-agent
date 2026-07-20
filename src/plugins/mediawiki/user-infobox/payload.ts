import type { MWPage, MWUser, MWUserContrib } from '../types/MediaWiki'

/** Payload consumed by user-infobox/index.html via the `data` query param. */
export interface UserInfoboxPayload {
  name: string
  userid: number
  /** Remote avatar URL, or null to fall back to the placeholder face. */
  avatar: string | null
  /** Formatted YYYY-MM-DD, or null when the wiki reports no registration date. */
  registration: string | null
  editcount: number
  /** Display-ready group names, implicit groups (`*`/`user`) stripped. */
  groups: string[]
  block: { by: string; reason: string; expiry: string } | null
  contribs: { title: string; time: string }[]
}

/**
 * Whitelist of "title" user groups worth surfacing, mapped to Chinese names.
 * Doubles as an allowlist: groups absent here (implicit `*`/`user`, and technical
 * groups like abusefilter / autoconfirmed / flow-bot / suppressredirect) are dropped
 * rather than shown as raw English keys.
 */
const GROUP_DISPLAY_NAMES: Record<string, string> = {
  sysop: '管理员',
  bureaucrat: '行政员',
  'interface-admin': '界面管理员',
  patroller: '巡查员',
  bot: '机器人',
  oversight: '监督员',
  suppress: '监督员',
  checkuser: '用户查核员',
  steward: '监管员',
  import: '导入者',
  transwiki: '跨维基导入者',
}

const MAX_CONTRIBS = 3

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Shift a UTC ISO timestamp into UTC+8, reading via getUTC* so the host TZ never leaks in. */
function toUtc8(iso: string): Date {
  return new Date(new Date(iso).getTime() + 8 * 60 * 60 * 1000)
}

/** UTC+8 `YYYY-MM-DD`. */
export function formatDate(iso: string): string {
  const d = toUtc8(iso)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** UTC+8 `MM-DD HH:mm`. */
export function formatDateTime(iso: string): string {
  const d = toUtc8(iso)
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/** Block expiry → `永久` for indefinite blocks, otherwise a UTC+8 date. */
export function formatExpiry(expiry?: string): string {
  if (!expiry) return ''
  if (/^(infinity|infinite|indefinite|never)$/i.test(expiry)) return '永久'
  return formatDate(expiry)
}

/** Keep only whitelisted title groups, mapped to Chinese, deduped (e.g. oversight+suppress). */
export function normalizeGroups(groups: string[]): string[] {
  const out: string[] = []
  for (const g of groups) {
    const name = GROUP_DISPLAY_NAMES[g]
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

export function buildUserInfoboxPayload(
  user: MWUser,
  contribs: MWUserContrib[],
  avatarUrl?: string
): UserInfoboxPayload {
  return {
    name: user.name,
    userid: user.userid,
    avatar: avatarUrl ?? null,
    registration: user.registration ? formatDate(user.registration) : null,
    editcount: user.editcount ?? 0,
    groups: normalizeGroups(user.groups ?? []),
    block: user.blockedby
      ? {
          by: user.blockedby,
          reason: user.blockreason || '',
          expiry: formatExpiry(user.blockexpiry),
        }
      : null,
    contribs: (contribs ?? []).slice(0, MAX_CONTRIBS).map((c) => ({
      title: c.title,
      time: formatDateTime(c.timestamp),
    })),
  }
}

/** Extract the page-subject (drop the localized `Namespace:` prefix). */
export function subjectOf(title: string): string {
  const idx = title.indexOf(':')
  return idx === -1 ? title : title.slice(idx + 1)
}

/**
 * Gate for the pseudo-infobox: a ns=2 root user page (valid title, not a subpage).
 * Usernames can't contain `/`, so any `/` marks a subpage. Does NOT check `missing`
 * — an active user often has a red-linked user page.
 */
export function isUserRootPage(page: MWPage): boolean {
  return (
    page.ns === 2 &&
    page.invalid === undefined &&
    !subjectOf(page.title).includes('/')
  )
}
