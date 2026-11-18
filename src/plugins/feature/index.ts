/**
 * Service levels: which commands run in which chat. See
 * docs/superpowers/specs/2026-11-18-feature-flags-design.md.
 *
 * A chat's level is its activation (qqbot): unactivated 0, activated 1.
 * A command runs where its level (default 1) is at most the chat's, unless the
 * chat overrides it. Every call path (message, shortcut, fallback, LLM tool)
 * crosses `command/before-execute`, so the check lives there and nowhere else.
 */
import { Argv, Command, Context, Service, Session } from 'koishi'

import { GUARDED_PLATFORMS } from '../qqbot/gate'
import {
  type CommandNode,
  FEATURE_COMMAND,
  NO_OVERRIDES,
  type OverrideAction,
  type Overrides,
  applyOverride,
  isOn,
  levelOf,
} from './rules'

export { FEATURE_COMMAND } from './rules'

declare module 'koishi' {
  namespace Command {
    interface Config {
      /** Service level; undeclared means 1. Subcommands inherit it. */
      level?: number
    }
  }
  interface Argv {
    /** Set by the LLM tool: a refusal must explain itself to the model. */
    viaAgent?: boolean
  }
  interface Context {
    feature: FeatureService
  }
  interface Tables {
    feature_override: FeatureOverride
  }
}

/** Per-chat deviations from the level default. */
export interface FeatureOverride {
  platform: string
  /** Group channel id, or `private:<user id>` for a DM. */
  id: string
  /** Command name → forced on (true) or off (false). */
  override: Record<string, boolean>
}

export interface Config {
  /** Levels of third-party commands, which cannot declare one themselves. */
  levels?: Record<string, number>
}

export interface FeatureRow {
  name: string
  description: string
  level: number
  on: boolean
  /** Overridden away from the level default here. */
  overridden: boolean
}

const AGENT_REFUSAL =
  'This feature is not enabled in this chat. Tell the user it is unavailable here; do not retry or try to work around it.'

const node = (command: Command) => command as unknown as CommandNode

export function chatIdOf(session: Pick<Session, 'isDirect' | 'userId' | 'channelId'>) {
  return session.isDirect ? `private:${session.userId}` : (session.channelId ?? '')
}

export default class FeatureService extends Service {
  static inject = ['database', 'qqbot']

  private overrides = new Map<string, Overrides>()

  constructor(
    ctx: Context,
    private options: Config = {}
  ) {
    super(ctx, 'feature')
    ctx.model.extend(
      'feature_override',
      {
        platform: 'string(32)',
        id: 'string(128)',
        override: 'json',
      },
      { primary: ['platform', 'id'] }
    )

    for (const command of this.commands()) this.declare(command)
    ctx.on('command-added', (command) => this.declare(command))

    // Prepended: must answer before core's authority check replies "权限不足".
    ctx.on(
      'command/before-execute',
      (argv: Argv) => {
        const { session, command } = argv
        if (!session || !command) return
        if (this.allows(session, command)) return
        return argv.viaAgent ? AGENT_REFUSAL : ''
      },
      true
    )

    ctx.on('ready', async () => {
      await this.reload()
      this.checkLevelZeroContexts()
    })

    this.setupCommand()
  }

  private commands(): Command[] {
    return (this.ctx.$commander as any)._commandList
  }

  private declare(command: Command) {
    const level = this.options.levels?.[command.name]
    if (typeof level === 'number' && command.config.level === undefined)
      command.config.level = level
  }

  async reload() {
    const rows = await this.ctx.database.get('feature_override', {})
    this.overrides = new Map(
      rows.map((r) => [`${r.platform}:${r.id}`, r.override ?? {}])
    )
  }

  overridesOf(platform: string, chatId: string): Overrides {
    return this.overrides.get(`${platform}:${chatId}`) ?? NO_OVERRIDES
  }

  /** Activated (served) chats are level 1; non-QQ platforms always are. */
  chatLevel(session: Session) {
    return this.ctx.qqbot.state.isServedSession(session) ? 1 : 0
  }

  allows(session: Session, command: Command): boolean {
    if (command.name === FEATURE_COMMAND) return true
    return isOn(
      node(command),
      this.overridesOf(session.platform, chatIdOf(session)),
      this.chatLevel(session)
    )
  }

  async override(
    platform: string,
    chatId: string,
    chatLevel: number,
    name: string,
    action: OverrideAction
  ) {
    const command = this.ctx.$commander.get(name)
    if (!command) throw new Error(`unknown command ${name}`)
    const next = applyOverride(
      this.overridesOf(platform, chatId),
      command.name,
      levelOf(node(command)) <= chatLevel,
      action
    )
    await this.ctx.database.upsert('feature_override', [
      { platform, id: chatId, override: { ...next } },
    ])
    this.overrides.set(`${platform}:${chatId}`, next)
  }

  /** Top-level commands and their state in one chat, for the console. */
  list(platform: string, chatId: string, chatLevel: number): FeatureRow[] {
    const overrides = this.overridesOf(platform, chatId)
    return this.commands()
      .filter((c) => (!c.parent || c.parent === (c as any)._root) && c.name !== FEATURE_COMMAND)
      .map((c) => ({
        name: c.name,
        description:
          this.ctx.i18n.text(['zh'], [`commands.${c.name}.description`], {}) ||
          (c as any)._description ||
          '',
        level: levelOf(node(c)),
        on: isOn(node(c), overrides, chatLevel),
        overridden: c.name in overrides,
      }))
      .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name))
  }

  /**
   * Level-0 commands must be registered in a context that sees unactivated
   * chats, or they silently never run there. Probe each with a fake
   * unactivated QQ group.
   */
  private checkLevelZeroContexts() {
    const probe = {
      platform: 'qq',
      isDirect: false,
      selfId: 'feature-probe',
      channelId: 'feature-probe',
      userId: 'feature-probe',
      event: {},
    } as unknown as Session
    const logger = this.ctx.logger('feature')
    for (const command of this.commands()) {
      if (levelOf(node(command)) !== 0) continue
      try {
        if (!command.ctx.filter(probe))
          logger.error('level-0 command %s cannot reach unactivated chats', command.name)
      } catch (error) {
        logger.warn('probe %s', command.name, error)
      }
    }
  }

  private setupCommand() {
    this.ctx
      .command(`${FEATURE_COMMAND} [...names:string]`, '查看和开关本群的功能', {
        authority: 3,
      })
      .alias('feat', '功能')
      .userFields(['authority'])
      .option('enable', '-e 强制打开')
      .option('disable', '-d 强制关闭')
      .option('reset', '-r 恢复默认')
      .option('activate', '-a 激活本群（配合 -r 取消激活）')
      .action(async ({ session, options }, ...names) => {
        if (!session) return
        const authority = session.user?.authority ?? 0
        const { platform } = session
        const level = this.chatLevel(session)

        if (options?.activate) {
          if (session.isDirect || !GUARDED_PLATFORMS.has(platform))
            return '只能在官方 bot 所在的群里激活。私聊激活请用 user.activate。'
          if (authority < 4) return '只有 op 能激活或取消激活。'
          if (options.reset) {
            if (!level) return '这个群本来就没有激活。'
            await this.ctx.qqbot.deactivateGroup(platform, session.selfId, session.channelId!)
            return '好的，这个群回到试用功能了。'
          }
          if (level) return '这个群已经激活啦。'
          await this.ctx.qqbot.activateGroup(platform, session.selfId, session.channelId!, session)
          return '好的，SILI 在这个群激活啦！'
        }

        if (+!!options?.enable + +!!options?.disable + +!!options?.reset > 1)
          return '-e、-d、-r 只能选一个。'
        const action: OverrideAction | null = options?.enable
          ? 'enable'
          : options?.disable
            ? 'disable'
            : options?.reset
              ? 'reset'
              : null
        if (!action || !names.length) return this.describe(session)

        const done: string[] = []
        const refused: string[] = []
        for (const raw of names) {
          const command = this.ctx.$commander.get(raw)
          if (!command || command.name === FEATURE_COMMAND) {
            refused.push(`${raw}（没有这个功能）`)
            continue
          }
          const commandLevel = levelOf(node(command))
          if (session.resolve(command.config.authority) > authority) {
            refused.push(`${command.name}（权限不足）`)
            continue
          }
          if (action === 'enable' && commandLevel > level && authority < 4) {
            refused.push(`${command.name}（本群服务等级不足，只有 op 能打开）`)
            continue
          }
          if (action === 'enable' && commandLevel > 0 && level === 0) {
            refused.push(`${command.name}（本群未激活，请先 feature -a）`)
            continue
          }
          await this.override(platform, chatIdOf(session), level, command.name, action)
          done.push(command.name)
        }
        const verb = { enable: '打开', disable: '关闭', reset: '恢复默认' }[action]
        const lines: string[] = []
        if (done.length) lines.push(`已${verb}：${done.join('、')}`)
        if (refused.length) lines.push(`没有改动：${refused.join('、')}`)
        return lines.join('\n')
      })
  }

  private describe(session: Session) {
    const overrides = this.overridesOf(session.platform, chatIdOf(session))
    const level = this.chatLevel(session)
    const lines = [
      `${session.isDirect ? '本私聊' : '本群'}：${level ? '已激活' : '试用（只有基础功能）'}`,
    ]
    const on = Object.keys(overrides).filter((n) => overrides[n])
    const off = Object.keys(overrides).filter((n) => !overrides[n])
    if (on.length) lines.push(`强制打开：${on.join('、')}`)
    if (off.length) lines.push(`强制关闭：${off.join('、')}`)
    if (lines.length === 1) lines.push('没有单独开关的功能。')
    return lines.join('\n')
  }
}
