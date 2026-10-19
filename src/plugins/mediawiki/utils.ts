import { MediaWikiApi } from 'wiki-saikou/node'

import type { MWTitleMappings } from './types/MediaWiki'

const MW_CLIENTS = new Map<string, MediaWikiApi>()
const MOCK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'

export async function useApi(baseURL: string): Promise<MediaWikiApi> {
  // 这几个常量被故意放在函数内，是为了在运行时动态获取环境变量
  const MW_ACCOUNTS: {
    match: (url: string) => boolean
    username: string
    password: string
  }[] = [
    {
      match: (url: string) => url.includes('.moegirl.org.cn'),
      username: process.env.MW_BOTPASSWORD_MOEGIRL_USERNAME,
      password: process.env.MW_BOTPASSWORD_MOEGIRL_PASSWORD,
    },
  ]
  const MOCK_HEADER = [
    {
      match: (url: string) => url.includes('huijiwiki.com'),
      headers: {
        'User-Agent': MOCK_UA,
      },
    },
    {
      match: (url: string) => url.includes('ngnl.wiki'),
      headers: {
        'User-Agent': MOCK_UA,
      },
    },
    {
      match: (url: string) => url.includes('.moegirl.org.cn'),
      headers: {
        'User-Agent': process.env.TOKEN_MOEGIRL_USER_AGENT,
      },
    },
  ]

  if (MW_CLIENTS.has(baseURL)) {
    return MW_CLIENTS.get(baseURL)!
  }

  const api = new MediaWikiApi({ baseURL })
  MW_CLIENTS.set(baseURL, api)

  const mockHeaders = MOCK_HEADER.find((i) => i.match(baseURL))
  if (mockHeaders) {
    console.info('[MWAPI]', 'Use mock headers:', baseURL, mockHeaders.headers)
    api.config.fexiosConfigs.headers ||= {}
    Object.assign(api.config.fexiosConfigs.headers, mockHeaders.headers)
  }

  const auth = MW_ACCOUNTS.find((i) => i.match(baseURL))
  if (auth && auth.username && auth.password) {
    await api
      .login(
        auth.username,
        auth.password,
        {},
        { autoRelogin: true, autoReloginRetries: 3 }
      )
      .then(({ lgusername, lguserid }) => {
        console.info('[MWAPI]', 'Login success:', baseURL, lgusername, lguserid)
      })
      .catch((err) => {
        console.error(
          '[MWAPI]',
          'Login failed:',
          baseURL,
          auth.username,
          err.message || err
        )
        MW_CLIENTS.delete(baseURL)
      })
  }

  return api
}

export function getWikiTitleDBKey(raw: string): string {
  const title = raw
    .replace(/[\s_]+/g, ' ')
    .trim()
    .replace(/\s+/g, '_')
  return title[0].toUpperCase() + title.slice(1)
}
export function getWikiDisplayTitle(raw: string) {
  const title = raw.replace(/[\s_]+/g, ' ').trim()
  return title[0].toUpperCase() + title.slice(1)
}
export function parseTitlesFromText(str: string) {
  str = resolveBrackets(str)
  const reg = /\[\[(.+?)\]\]/g
  return Array.from(
    new Set(
      Array.from(str.matchAll(reg))
        .map((i) => i[1].split('|')[0])
        .map(getWikiTitleDBKey)
    )
  ).filter((i) => !!i)
}

/**
 * Follow action=query's normalized → converted → redirects chain from an
 * input title to the page title it finally resolved to. Matching input titles
 * against `page.title` directly breaks on namespace aliases (T: → Template:),
 * variant conversion and plain redirects.
 */
export function resolveQueriedTitle(
  title: string,
  query: {
    normalized?: MWTitleMappings
    converted?: MWTitleMappings
    redirects?: MWTitleMappings
  }
): string {
  for (const mappings of [query.normalized, query.converted, query.redirects]) {
    title = mappings?.find((i) => i.from === title)?.to ?? title
  }
  return title
}

export function getUrl(base: string, params = {}, script = 'index'): string {
  const query = Object.keys(params).length
    ? '?' + new URLSearchParams(params)
    : ''
  return `${base.replace(
    '/api.php',
    `/${script ? script.trim() : 'index'}.php`
  )}${query}`
}

export function isValidApi(api: string | URL): boolean {
  let url: URL
  try {
    url = new URL(api)
  } catch (err) {
    return false
  }
  const { protocol, pathname } = url
  if (protocol.startsWith('http') && pathname.endsWith('/api.php')) {
    return true
  }
  return false
}

export function resolveBrackets(str: string): string {
  return str
    .replace(new RegExp('&#91;', 'g'), '[')
    .replace(new RegExp('&#93;', 'g'), ']')
}
