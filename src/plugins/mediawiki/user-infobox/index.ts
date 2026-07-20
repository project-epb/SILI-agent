import { Context, h } from 'koishi'

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { MediaWikiApi } from 'wiki-saikou/node'

import { INFOBOX_DEFINITION } from '../infoboxes'
import type { MWPage, MWUser, MWUserContrib } from '../types/MediaWiki'
import { buildUserInfoboxPayload, subjectOf } from './payload'

export {
  buildUserInfoboxPayload,
  formatDate,
  formatDateTime,
  formatExpiry,
  isUserRootPage,
  normalizeGroups,
} from './payload'
export type { UserInfoboxPayload } from './payload'

const MAX_CONTRIBS = 3

/**
 * Fetch user info + recent contribs for a ns=2 root page and render a pseudo-infobox.
 * Returns '' when the user does not exist (missing/invalid — e.g. IP users) or on failure,
 * so the caller can silently skip sending an image.
 */
export async function shotUserInfobox(
  ctx: Context,
  api: MediaWikiApi,
  page: MWPage
): Promise<h | ''> {
  const logger = ctx.logger('mediawiki')
  const username = subjectOf(page.title)

  try {
    const { data } = await api.get<{
      query: { users?: MWUser[]; usercontribs?: MWUserContrib[] }
    }>({
      action: 'query',
      list: 'users|usercontribs',
      ususers: username,
      usprop: 'blockinfo|groups|editcount|registration',
      ucuser: username,
      ucprop: 'title|timestamp',
      uclimit: MAX_CONTRIBS,
    })

    const user = data?.query?.users?.[0]
    // 用户不存在（missing）或用户名非法（invalid，如 IP 用户）→ 不出图
    if (!user || user.missing !== undefined || user.invalid !== undefined) {
      return ''
    }

    const matched = INFOBOX_DEFINITION.find((i) =>
      i.match(new URL(page.canonicalurl))
    )
    const avatarUrl = matched?.getAvatarUrl?.({
      userid: user.userid,
      name: user.name,
    })

    const payload = buildUserInfoboxPayload(
      user,
      data.query.usercontribs ?? [],
      avatarUrl
    )

    const url = pathToFileURL(resolve(import.meta.dirname, 'index.html'))
    url.searchParams.set('data', JSON.stringify(payload))

    const buf = await ctx.html.shotByUrl(url, '#user-infobox')
    return buf ? h.image(buf, 'image/jpeg') : ''
  } catch (e) {
    logger.warn('SHOT_USER_INFOBOX', 'Failed', e)
    return ''
  }
}
