/**
 * Pure access-control decisions for v5. No Koishi runtime here so every branch
 * is unit-testable; the plugin feeds it session facts and the served state.
 */

/** Platforms where nothing is served unless explicitly activated. */
export const GUARDED_PLATFORMS = new Set(['qq', 'qqguild'])

export interface SessionFacts {
  platform: string
  isDirect: boolean
  selfId: string
  channelId: string
  userId: string
}

export interface ServedLookup {
  /** Group (or guild channel) whose `channel.assignee` is this bot. */
  isGroupActive(platform: string, selfId: string, channelId: string): boolean
  /** DM sender is an op (`authority >= 4`) or their DM was activated. */
  isDmAllowed(platform: string, selfId: string, userId: string): boolean
}

/**
 * Whether ordinary plugins may see this session. OneBot is never served in v5:
 * it only receives bind codes during the migration window, and its old
 * channel rows still name SILI's QQ number as assignee, so `assignee` must not
 * be trusted for it.
 */
export function isServed(facts: SessionFacts, served: ServedLookup): boolean {
  if (facts.platform === 'onebot') return false
  if (!GUARDED_PLATFORMS.has(facts.platform)) return true
  if (facts.isDirect) {
    return served.isDmAllowed(facts.platform, facts.selfId, facts.userId)
  }
  return served.isGroupActive(facts.platform, facts.selfId, facts.channelId)
}

export interface GateRules {
  /** Command names and aliases allowed in unactivated groups. */
  groupCommands: ReadonlySet<string>
  /** Command names and aliases allowed in unserved DMs. */
  dmCommands: ReadonlySet<string>
  /** OneBot messages starting with this pass through (plugin-bind codes). */
  bindTokenPrefix: string
}

export type GateVerdict = 'pass' | 'drop'

/**
 * The single gate every message crosses before Koishi attaches users and
 * channels. Served sessions pass; unserved ones pass only for the few
 * whitelisted commands, everything else is dropped silently.
 */
export function decideGate(
  facts: SessionFacts,
  content: string,
  commandName: string | null,
  served: ServedLookup,
  rules: GateRules
): GateVerdict {
  if (facts.platform === 'onebot') {
    return content.trim().startsWith(rules.bindTokenPrefix) ? 'pass' : 'drop'
  }
  if (isServed(facts, served)) return 'pass'
  const allowed = facts.isDirect ? rules.dmCommands : rules.groupCommands
  return commandName && allowed.has(commandName) ? 'pass' : 'drop'
}

/**
 * First word of a message after stripping one command prefix, lowercased.
 * `content` is expected with the @-mention already removed (Koishi's
 * `session.stripped.content`).
 */
export function extractCommandName(
  content: string,
  prefixes: readonly string[]
): string | null {
  let text = content.trim()
  // Longest prefix first so '!!' wins over '!'.
  for (const prefix of [...prefixes].sort((a, b) => b.length - a.length)) {
    if (prefix && text.startsWith(prefix)) {
      text = text.slice(prefix.length).trimStart()
      break
    }
  }
  const word = text.split(/\s+/, 1)[0]
  return word ? word.toLowerCase() : null
}

/**
 * Koishi `autoAuthorize`: 0 means "do not create a user row". Unserved
 * sessions on guarded platforms must not create users (strangers would fill
 * the table), except a DM that runs a whitelisted command: plugin-bind
 * rewrites the initiator's existing binding row, so that row must exist.
 */
export function autoAuthorizeFor(
  facts: SessionFacts,
  commandName: string | null,
  served: ServedLookup,
  rules: GateRules
): 0 | 1 {
  if (facts.platform === 'onebot') return 0
  if (!GUARDED_PLATFORMS.has(facts.platform)) return 1
  if (isServed(facts, served)) return 1
  if (facts.isDirect && commandName && rules.dmCommands.has(commandName)) return 1
  return 0
}

/** Koishi `autoAssign`: never auto-claim channels on guarded platforms or OneBot. */
export function autoAssignFor(platform: string): boolean {
  return platform !== 'onebot' && !GUARDED_PLATFORMS.has(platform)
}
