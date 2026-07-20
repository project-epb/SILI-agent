export type MWPages = MWPage[]
export interface MWPage {
  pageid: number
  ns: number
  title: string
  extract: string
  contentmodel: string
  pagelanguage: string
  pagelanguagehtmlcode: string
  pagelanguagedir: string
  touched: string
  lastrevid: number
  length: number
  fullurl: string
  editurl: string
  canonicalurl: string
  displaytitle: string
  special?: boolean
  invalid?: boolean
  invalidreason?: string
  missing?: boolean
}

export type MWRedirects = MWRedirect[]
export interface MWRedirect {
  from: string
  to: string
  tofragment?: string
}

export type MWInterwikiLinks = MWInterwiki[]
export interface MWInterwiki {
  title: string
  iw: string
  url: string
}

export type MWSpecialPageAliases = MWSpecialPageAlias[]
export interface MWSpecialPageAlias {
  realname: string
  aliases: string[]
}

export type MWNamespaceAliases = MWNamespaceAlias[]
export interface MWNamespaceAlias {
  id: number
  alias: string
}

export interface MWUser {
  userid: number
  name: string
  editcount?: number
  /** ISO timestamp, or null for legacy accounts with no recorded registration. */
  registration?: string | null
  groups?: string[]
  // blockinfo (present only when blocked)
  blockid?: number
  blockedby?: string
  blockedbyid?: number
  blockreason?: string
  blockexpiry?: string
  blocktimestamp?: string
  // absence markers
  missing?: boolean
  invalid?: boolean
}

export interface MWUserContrib {
  userid: number
  user: string
  ns: number
  title: string
  timestamp: string
}

export type MWNamespaces = Record<string, MWNamespace>
export interface MWNamespace {
  id: number
  case: string
  name: string
  subpages: boolean
  canonical: string
  content: boolean
  nonincludable: boolean
}
