/**
 * v5 access control for the official QQ bot, plus migration helpers.
 * Design: docs/superpowers/specs/2026-11-13-v5-access-control-design.md and
 * 2026-11-13-onebot-to-qqbot-migration-design.md.
 *
 * Layering:
 * - Ordinary plugins live in a "served" context (`ctx.intersect(isServed)`), so
 *   their middleware, listeners and commands never see unserved sessions. That
 *   is what keeps a prepend middleware such as FallbackHandler from turning an
 *   @ in a stranger's group into an LLM call.
 * - This service sits outside that context and owns one prepend middleware,
 *   the gate. Core `attach` is the first prepend registered (at App
 *   construction) so every later prepend, including this one, runs before
 *   Koishi loads channels or users.
 * - `autoAuthorize` / `autoAssign` (App options, see `accessAppOptions`) stop
 *   Koishi from creating user and channel rows for strangers on every other
 *   path (e.g. `session.execute`).
 */
import { Context, Next, Service, Session, Time, h } from 'koishi'

import {
  GUARDED_PLATFORMS,
  type GateRules,
  autoAssignFor,
  autoAuthorizeFor,
  decideGate,
  extractCommandName,
  isServed,
} from './gate'
import { MetadataRecorder } from './metadata'
import {
  GROUP_MIGRATE_COMMAND,
  MigrationFeatures,
  migrationNotice,
  oldAccountNotice,
} from './migration'
import { setupGroupPanel } from './panel'
import { passiveFallback } from './passive'
import { ServedState, factsOf, isFromBot } from './state'
import { defineTables } from './tables'

export { ServedState } from './state'

declare module 'koishi' {
  interface Context {
    qqbot: QQBotService
  }
}

/** plugin-bind's default code prefix; SILI does not override it. */
export const BIND_TOKEN_PREFIX = 'koishi/'
/** Allowed in unactivated groups (with their aliases). */
/** Activates a group: all features, the LLM included. Ops only. */
const ACTIVATE_COMMAND = 'channel.activate'
const GROUP_COMMANDS = [ACTIVATE_COMMAND, GROUP_MIGRATE_COMMAND]
/** Allowed in unserved DMs (with their aliases). */
const DM_COMMANDS = ['bind']
/** Usable by anyone in an unactivated DM. wiki and github need a group. */
const PUBLIC_DM_COMMANDS = ['help', 'about', 'dice', 'sticker', 'manosaba']
/** Usable by anyone in an unactivated group; everything else needs activation. */
const PUBLIC_GROUP_COMMANDS = [
  'help',
  'about',
  'wiki',
  'dice',
  'sticker',
  'manosaba',
  'github',
]
/** `[[wiki links]]`, expanded by the mediawiki plugin. */
const WIKI_LINK = /\[\[.+?\]\]/

const PERMISSION_HINT =
  '💡 想获得最佳体验的话，请群主点击 SILI 的头像，在机器人权限中开启「接收全部消息」和「推送主动消息」'

/**
 * Names and aliases of these commands and all their subcommands (`wiki` lets
 * `wiki.connect` through too). Each command still checks its own authority.
 */
function commandWords(app: Context, names: string[]) {
  const words = new Set<string>()
  const add = (command: any) => {
    words.add(command.name.toLowerCase())
    for (const alias in command._aliases) words.add(alias.toLowerCase())
    for (const child of command.children ?? []) add(child)
  }
  for (const name of names) {
    words.add(name.toLowerCase())
    const command = app.$commander.get(name)
    if (command) add(command)
  }
  return words
}

function rulesOf(app: Context): GateRules {
  return {
    groupCommands: commandWords(app, GROUP_COMMANDS),
    publicGroupCommands: commandWords(app, PUBLIC_GROUP_COMMANDS),
    publicGroupContent: WIKI_LINK,
    dmCommands: commandWords(app, DM_COMMANDS),
    publicDmCommands: commandWords(app, PUBLIC_DM_COMMANDS),
    bindTokenPrefix: BIND_TOKEN_PREFIX,
  }
}

function commandOf(session: Session) {
  const content = session.stripped?.content ?? session.content ?? ''
  const resolved = session.resolve(session.app.koishi.config.prefix)
  const prefixes = (Array.isArray(resolved) ? resolved : [resolved]).filter(
    (p): p is string => typeof p === 'string'
  )
  return { content, command: extractCommandName(content, prefixes) }
}

/**
 * App-level options for profiles that use this service. Both are evaluated
 * synchronously by Koishi for every session, so they only read `state`.
 */
export function accessAppOptions(state: ServedState) {
  return {
    autoAssign: (session: Session) => autoAssignFor(session.platform),
    autoAuthorize: (session: Session) =>
      autoAuthorizeFor(
        factsOf(session),
        commandOf(session).command,
        state,
        rulesOf(session.app)
      ),
  }
}

export interface QQBotConfig {
  state: ServedState
  /** OneBot is loaded for bind codes, and first-activation notices are on. */
  migrationWindow: boolean
}

export default class QQBotService extends Service {
  static inject = ['database', 'channelMessageHistory']

  readonly state: ServedState
  readonly metadata: MetadataRecorder
  private pendingNotice = new Set<string>()
  /** Groups whose permission hint is being decided right now. */
  private hinting = new Set<string>()
  /** Last reminder per group (old OneBot account, or unactivated group), by `selfId:channelId`. */
  private remindedAt = new Map<string, number>()
  private shareUrl?: string

  constructor(
    ctx: Context,
    private options: QQBotConfig
  ) {
    super(ctx, 'qqbot')
    this.state = options.state
    defineTables(ctx)
    this.metadata = new MetadataRecorder(ctx, this.state)
    new MigrationFeatures(ctx, this)
    setupGroupPanel(ctx)
    this.setupActivateCommands()

    ctx.on('ready', () => this.reload())
    ctx.setInterval(() => this.reload(), 30 * Time.second)
    ctx.middleware((session, next) => this.gate(session, next), true)
    ctx.on('before-send', (out, options) => {
      // The OneBot account only answers bind codes and @-mentions during the
      // migration window. Sends with no source session (broadcasts: GitHub,
      // schedules) are cancelled; migrated groups get them via the QQ bot.
      if (out.platform === 'onebot' && !options?.session) return true
      passiveFallback(out, options)
    })
  }

  private setupActivateCommands() {
    this.ctx
      .command(`${ACTIVATE_COMMAND}`, '激活本群的全部功能', { authority: 4 })
      .alias('激活')
      .option('remove', '-r 取消激活')
      .action(async ({ session, options }) => {
        if (!session || !GUARDED_PLATFORMS.has(session.platform) || session.isDirect)
          return '请在要激活的群里使用这条命令。'
        const { platform, selfId, channelId } = session
        const active = this.state.isGroupActive(platform, selfId, channelId!)
        if (options?.remove) {
          if (!active) return 'SILI 本来就没有在这个群开通全部功能。'
          await this.deactivateGroup(platform, selfId, channelId!)
          return '好的，这个群回到基础功能了。'
        }
        if (active) return 'SILI 已经在这个群开通全部功能啦。'
        await this.activateGroup(platform, selfId, channelId!, session)
        return '好的，SILI 在这个群开通全部功能啦！'
      })

    this.ctx
      .command('user.activate <target:user>', '激活某人的私聊', { authority: 4 })
      .option('remove', '-r 取消激活')
      .action(async ({ session, options }, target) => {
        if (!session || !target) return '请指定要激活的用户。'
        const [platform, ...rest] = target.split(':')
        const userId = rest.join(':')
        if (!GUARDED_PLATFORMS.has(platform)) return '只能激活官方 bot 平台的用户。'
        await this.setDmActive(platform, session.selfId, userId, !options?.remove)
        return options?.remove ? '已取消这个人的私聊激活。' : '已激活这个人的私聊。'
      })
  }

  /** Re-read activation, DM permissions and ops from the database. */
  async reload() {
    try {
      await this.state.reload(this.ctx)
      const pending = await this.ctx.database.get(
        'qqbot_channel',
        { noticePending: true },
        ['selfId', 'id']
      )
      this.pendingNotice = new Set(
        pending.map((row) => `${row.selfId}:${row.id}`)
      )
    } catch (error) {
      this.logger.warn('reload served state', error)
    }
  }

  private async gate(session: Session, next: Next) {
    const { platform } = session
    const guarded = GUARDED_PLATFORMS.has(platform)
    if (!guarded && platform !== 'onebot') {
      if (await this.ctx.channelMessageHistory.record(session)) return next()
      return
    }

    const facts = factsOf(session)
    const { content, command } = commandOf(session)
    const rules = rulesOf(this.ctx)
    if (guarded) this.metadata.record(session)
    if (decideGate(facts, content, command, this.state, rules) === 'drop') {
      if (platform === 'onebot') void this.remindOnOldAccount(session)
      else if (guarded && command && !rules.dmCommands.has(command))
        void this.remindUnactivated(session)
      return
    }

    if (guarded && isServed(facts, this.state)) {
      // A duplicate push was already handled once.
      if (!(await this.ctx.channelMessageHistory.record(session))) return
      if (!session.isDirect) void this.deliverPendingNotice(session)
    }

    // Other bots' messages stay in the history (LLM context) but reach no
    // plugin: their markdown headings start with the non-prod teach prefix
    // `#`, and bots answering bots loop.
    if (guarded && isFromBot(session)) return

    const result = await next()
    if (guarded && !session.isDirect && (command || session.stripped?.atSelf)) {
      void this.hintPermissionsOnce(session)
    }
    return result
  }

  /**
   * Activate a group: all features, the LLM included (`channel.activate`,
   * admin page, group migration). Also makes sure the group is assigned to
   * this bot, which is routing only.
   */
  async activateGroup(
    platform: string,
    selfId: string,
    channelId: string,
    via?: Session
  ) {
    await this.ctx.database.upsert('channel', [
      { platform, id: channelId, assignee: selfId, guildId: channelId },
    ])
    await this.ctx.database.upsert('qqbot_channel', [
      { selfId, id: channelId, platform, activated: true },
    ])
    const wasActive = this.state.isGroupActive(platform, selfId, channelId)
    this.state.setGroupActive(platform, selfId, channelId, true)
    if (!wasActive) await this.onActivated(platform, selfId, channelId, via)
  }

  /** Deactivate a group: back to the public commands only. */
  async deactivateGroup(platform: string, selfId: string, channelId: string) {
    await this.ctx.database.upsert('qqbot_channel', [
      { selfId, id: channelId, platform, activated: false },
    ])
    this.state.setGroupActive(platform, selfId, channelId, false)
  }

  /** Serve or stop serving one user's DMs. Ops are always served. */
  async setDmActive(
    platform: string,
    selfId: string,
    userId: string,
    active: boolean
  ) {
    await this.ctx.database.upsert('qqbot_user', [
      { selfId, id: userId, platform, dmActive: active },
    ])
    this.state.setDmActive(platform, selfId, userId, active)
  }

  /**
   * Set the Koishi authority of the account behind an openid. The platform has
   * no "bot owner" API, so this is how a new bot gets its first admins: the
   * person only needs to have messaged the bot once to be listed.
   *
   * Same rule as Koishi's `authorize`: the new level must be lower than the
   * operator's. Additionally an account at or above the operator's level
   * cannot be changed, and nobody edits themselves here. An openid without an
   * account gets one at the requested level.
   *
   * Authority lives on the Koishi account: after `bind` merges this identity
   * into an old account, the old account's authority applies.
   */
  async setAuthority(
    platform: string,
    userId: string,
    authority: number,
    operator: { id: number; authority: number }
  ): Promise<{ ok: boolean; message?: string }> {
    if (!Number.isInteger(authority) || authority < 0) {
      return { ok: false, message: '权限等级必须是非负整数。' }
    }
    if (authority >= operator.authority) {
      return {
        ok: false,
        message: `只能授予低于你自己（${operator.authority}）的权限等级。`,
      }
    }
    const db = this.ctx.database
    const [binding] = await db.get('binding', { platform, pid: userId }, [
      'aid',
    ])
    if (!binding) {
      await db.createUser(platform, userId, { authority })
    } else {
      if (binding.aid === operator.id) {
        return { ok: false, message: '不能在这里修改你自己的权限。' }
      }
      const [user] = await db.get('user', { id: binding.aid }, ['authority'])
      const current = user?.authority ?? 0
      if (current >= operator.authority) {
        return {
          ok: false,
          message: `该账号权限为 ${current}，不低于你自己，不能修改。`,
        }
      }
      await db.set('user', { id: binding.aid }, { authority })
    }
    await this.state.reload(this.ctx)
    return { ok: true }
  }

  /**
   * First activation during the migration window: tell the group how to bring
   * old data over. Prefer a passive reply to the message that activated the
   * group; otherwise a proactive message if allowed; otherwise owe it and send
   * it as a passive reply to the next served message there.
   */
  private async onActivated(
    platform: string,
    selfId: string,
    channelId: string,
    via?: Session
  ) {
    if (!this.options.migrationWindow || platform !== 'qq') return
    try {
      // The stored bot state dates from when the bot joined; read it fresh.
      await this.metadata.queueRefresh(selfId, channelId)
      const [row] = await this.ctx.database.get(
        'qqbot_channel',
        { selfId, id: channelId },
        ['noticeSentAt', 'allowProactive']
      )
      if (row?.noticeSentAt) return
      const text = await this.noticeText(selfId, channelId)
      if (via) {
        await via.send(text)
        return this.markNoticeSent(selfId, channelId)
      }
      const bot = this.ctx.bots.find(
        (b) => b.platform === platform && b.selfId === selfId
      )
      if (bot && row?.allowProactive) {
        await bot.sendMessage(channelId, text)
        return this.markNoticeSent(selfId, channelId)
      }
      await this.ctx.database.upsert('qqbot_channel', [
        { selfId, id: channelId, platform, noticePending: true },
      ])
      this.pendingNotice.add(`${selfId}:${channelId}`)
    } catch (error) {
      this.logger.warn('first-activation notice', error)
    }
  }

  /**
   * During the migration window the old OneBot account stays silent except
   * for one thing: when someone @-mentions it in a group, tell them it moved,
   * at most once per group every 8 hours. Reactive and rate-limited on purpose:
   * mass-broadcasting from a real QQ account is what triggers risk control.
   * The rate limit lives in memory; a restart may cost one extra reminder.
   */
  private async remindOnOldAccount(session: Session) {
    if (!this.options.migrationWindow || session.isDirect) return
    if (!session.stripped?.atSelf) return
    const key = `${session.selfId}:${session.channelId}`
    if (Date.now() - (this.remindedAt.get(key) ?? 0) < 8 * Time.hour) {
      return
    }
    this.remindedAt.set(key, Date.now())
    try {
      await session.send(oldAccountNotice(await this.newBotShareUrl()))
    } catch (error) {
      this.logger.warn('old account reminder', error)
    }
  }

  /**
   * In a group that is not activated, an @ to the bot gets one hint that the
   * group is not served yet, at most once per group every 8 hours (memory).
   * Everything else there stays silent, so the bot does not look broken to
   * people who pulled it in, without becoming a free chat target.
   */
  private async remindUnactivated(session: Session) {
    if (!session.isDirect && !session.stripped?.atSelf) return
    const key = `${session.selfId}:${session.channelId}`
    if (Date.now() - (this.remindedAt.get(key) ?? 0) < 8 * Time.hour) {
      return
    }
    this.remindedAt.set(key, Date.now())
    try {
      await session.send(
        session.isDirect
          ? 'SILI 还没给你开通这个功能，需要找小鱼君（824399619）激活哦'
          : 'SILI 还没在本群开通这个功能，需要找小鱼君（824399619）激活本群服务哦'
      )
    } catch (error) {
      this.logger.warn('unactivated group hint', error)
    }
  }

  /** The new bot's "add to group" link (`share_url` of /users/@me), cached. */
  private async newBotShareUrl() {
    if (this.shareUrl !== undefined) return this.shareUrl
    const bot = this.ctx.bots.find(
      (b) => GUARDED_PLATFORMS.has(b.platform) && (b as any).internal?.getMe
    ) as any
    if (!bot) return ''
    try {
      const me = await bot.internal.getMe()
      this.shareUrl = me?.share_url ?? ''
      return this.shareUrl
    } catch (error) {
      this.logger.debug('getMe failed: %s', (error as Error)?.message)
      return ''
    }
  }

  private async deliverPendingNotice(session: Session) {
    const key = `${session.selfId}:${session.channelId}`
    if (!this.pendingNotice.has(key)) return
    this.pendingNotice.delete(key)
    try {
      await session.send(
        await this.noticeText(session.selfId, session.channelId)
      )
      await this.markNoticeSent(session.selfId, session.channelId)
    } catch (error) {
      this.pendingNotice.add(key)
      this.logger.warn('deliver pending notice', error)
    }
  }

  private async noticeText(_selfId: string, channelId: string) {
    const migrated = await this.ctx.database.get('qqbot_migration', {
      kind: 'group',
      newId: channelId,
    })
    return migrationNotice(migrated.length > 0)
  }

  /**
   * The first time a group uses SILI, tell its owner how to enable the full
   * message and proactive permissions if either is off. Once per group, and
   * again after the bot is removed and re-added (QQ resets the permissions).
   * Activated or not: unactivated groups use the public commands too.
   */
  private async hintPermissionsOnce(session: Session) {
    const { selfId, channelId } = session
    const key = `${selfId}:${channelId}`
    if (this.hinting.has(key)) return
    this.hinting.add(key)
    try {
      const db = this.ctx.database
      const [row] = await db.get('qqbot_channel', { selfId, id: channelId }, [
        'permissionHintAt',
      ])
      if (row?.permissionHintAt) return
      await this.metadata.queueRefresh(selfId, channelId!)
      const [state] = await db.get(
        'qqbot_channel',
        { selfId, id: channelId },
        ['recvSetting', 'allowProactive']
      )
      if (state?.recvSetting !== 'all' || !state.allowProactive) {
        await session.send(PERMISSION_HINT)
      }
      await db.upsert('qqbot_channel', [
        { selfId, id: channelId, permissionHintAt: new Date() },
      ])
    } catch (error) {
      this.logger.warn('permission hint', error)
    } finally {
      this.hinting.delete(key)
    }
  }

  private async markNoticeSent(selfId: string, id: string) {
    await this.ctx.database.upsert('qqbot_channel', [
      { selfId, id, noticeSentAt: new Date(), noticePending: false },
    ])
  }
}

/**
 * Any session on a guarded platform, activated or not: the context of the
 * plugins behind the public commands. The gate decides what reaches them
 * from an unactivated group or DM.
 */
export function isGuardedSession(session: Session) {
  return GUARDED_PLATFORMS.has(session.platform)
}

/** Filter for the served context of a profile. */
export function servedFilter(state: ServedState) {
  return (session: Session) => state.isServedSession(session)
}
