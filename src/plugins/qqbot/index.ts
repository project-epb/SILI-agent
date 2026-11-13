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
import { Context, Next, Service, Session, Time } from 'koishi'

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
} from './migration'
import { ServedState, factsOf } from './state'
import { MessageStore } from './store'
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
const GROUP_COMMANDS = ['assign', GROUP_MIGRATE_COMMAND]
/** Allowed in unserved DMs (with their aliases). */
const DM_COMMANDS = ['bind']

function commandWords(app: Context, names: string[]) {
  const words = new Set<string>()
  for (const name of names) {
    words.add(name.toLowerCase())
    const command = app.$commander.get(name)
    if (command) {
      for (const alias in command._aliases) words.add(alias.toLowerCase())
    }
  }
  return words
}

function rulesOf(app: Context): GateRules {
  return {
    groupCommands: commandWords(app, GROUP_COMMANDS),
    dmCommands: commandWords(app, DM_COMMANDS),
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
  /** Days to keep stored messages. */
  retentionDays?: number
}

export default class QQBotService extends Service {
  static inject = ['database']

  readonly state: ServedState
  readonly store: MessageStore
  readonly metadata: MetadataRecorder
  private pendingNotice = new Set<string>()

  constructor(
    ctx: Context,
    private options: QQBotConfig
  ) {
    super(ctx, 'qqbot')
    this.state = options.state
    defineTables(ctx)
    this.store = new MessageStore(ctx, this.state, options.retentionDays ?? 30)
    this.metadata = new MetadataRecorder(ctx, this.state)
    new MigrationFeatures(ctx, this)

    ctx.on('ready', () => this.reload())
    ctx.setInterval(() => this.reload(), 30 * Time.second)
    ctx.middleware((session, next) => this.gate(session, next), true)
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
    if (!guarded && platform !== 'onebot') return next()

    const facts = factsOf(session)
    const { content, command } = commandOf(session)
    const rules = rulesOf(this.ctx)
    if (guarded) this.metadata.record(session)
    if (decideGate(facts, content, command, this.state, rules) === 'drop')
      return

    if (guarded && isServed(facts, this.state)) {
      // A duplicate push was already handled once.
      if (!(await this.store.insert(session))) return
      if (!session.isDirect) void this.deliverPendingNotice(session)
    }

    const result = await next()
    if (
      guarded &&
      !session.isDirect &&
      command &&
      commandWords(this.ctx, ['assign']).has(command)
    ) {
      this.afterAssign(session)
    }
    return result
  }

  /**
   * `assign` writes `channel.assignee` through Koishi's observed channel, which
   * is saved after the middleware chain; re-read it shortly after.
   */
  private afterAssign(session: Session) {
    const { platform, selfId, channelId } = session
    this.ctx.setTimeout(async () => {
      try {
        const [row] = await this.ctx.database.get(
          'channel',
          { platform, id: channelId },
          ['assignee']
        )
        const active = row?.assignee === selfId
        const wasActive = this.state.isGroupActive(platform, selfId, channelId)
        this.state.setGroupActive(platform, selfId, channelId, active)
        if (active && !wasActive)
          await this.onActivated(platform, selfId, channelId, session)
      } catch (error) {
        this.logger.warn('after assign', error)
      }
    }, 1500)
  }

  /** Activate a group (admin page, group migration). Equivalent to `assign`. */
  async activateGroup(
    platform: string,
    selfId: string,
    channelId: string,
    via?: Session
  ) {
    await this.ctx.database.upsert('channel', [
      { platform, id: channelId, assignee: selfId, guildId: channelId },
    ])
    const wasActive = this.state.isGroupActive(platform, selfId, channelId)
    this.state.setGroupActive(platform, selfId, channelId, true)
    if (!wasActive) await this.onActivated(platform, selfId, channelId, via)
  }

  /** Deactivate a group. Equivalent to `assign -r`. */
  async deactivateGroup(platform: string, selfId: string, channelId: string) {
    await this.ctx.database.set(
      'channel',
      { platform, id: channelId, assignee: selfId },
      { assignee: '' }
    )
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
      const [row] = await this.ctx.database.get(
        'qqbot_channel',
        { selfId, id: channelId },
        ['noticeSentAt', 'allowProactive']
      )
      if (row?.noticeSentAt) return
      const text = await this.noticeText(channelId)
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

  private async deliverPendingNotice(session: Session) {
    const key = `${session.selfId}:${session.channelId}`
    if (!this.pendingNotice.has(key)) return
    this.pendingNotice.delete(key)
    try {
      await session.send(await this.noticeText(session.channelId))
      await this.markNoticeSent(session.selfId, session.channelId)
    } catch (error) {
      this.pendingNotice.add(key)
      this.logger.warn('deliver pending notice', error)
    }
  }

  private async noticeText(channelId: string) {
    const migrated = await this.ctx.database.get('qqbot_migration', {
      kind: 'group',
      newId: channelId,
    })
    return migrationNotice(migrated.length > 0)
  }

  private async markNoticeSent(selfId: string, id: string) {
    await this.ctx.database.upsert('qqbot_channel', [
      { selfId, id, noticeSentAt: new Date(), noticePending: false },
    ])
  }
}

/** Filter for the served context of a profile. */
export function servedFilter(state: ServedState) {
  return (session: Session) => state.isServedSession(session)
}
