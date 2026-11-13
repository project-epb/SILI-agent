import { Bot, Command, Context, Logger, Session, Universal } from 'koishi'

import type QQBotService from './index'

export const BIND_ALIAS = '多账号绑定'
export const GROUP_MIGRATE_COMMAND = 'group-migrate'
export const GROUP_MIGRATE_ALIAS = '迁移群设置'

/**
 * plugin-bind's own zh-CN copy talks about "原始平台 / 目标平台" and is hard to
 * follow. The direction is expressed as 大号 / 小号 instead: the account that
 * runs `bind` becomes the 小号 of the account that sends the code. Kept generic
 * because `bind` also links Discord, DingTalk, etc.
 */
const BIND_COPY = {
  description: '把多个账号绑成同一个人',
  options: { remove: '取消绑定，恢复成独立账号' },
  messages: {
    'generated-1': [
      '绑定码：{0}',
      '请在 5 分钟内，用你的大号（要保留数据的那个账号）把这串码发给 SILI。',
      '之后，当前账号会被视为你的小号：',
      '· 小号说的话，SILI 都当成大号说的',
      '· 小号原来的记忆、权限、称呼暂停使用，取消绑定后恢复',
      '想取消，在当前账号发「bind -r」。',
    ].join('\n'),
    'generated-2': [
      '还差一步：请在 5 分钟内，用刚才发起绑定的那个账号把这串码发给 SILI：',
      '{0}',
      '完成后，那个账号会被视为你的小号，数据以当前账号为准。',
    ].join('\n'),
    'self-1': '要用你的大号发，不是当前这个账号。',
    'self-2': '要用刚才发起绑定的那个账号发，不是当前这个账号。',
    // Either side may see this one, so it must not name 大号 or 小号.
    success: '绑定成功，两个账号现在算同一个人。',
    'remove-success': '已取消绑定，当前账号恢复成独立账号，原来的数据也回来了。',
    'remove-original': '这是大号本身，没有可以取消的绑定。',
  },
}

export function migrationNotice(oldSiliIsHere: boolean) {
  return [
    'SILI换新账号啦！旧号上的记忆、称呼和权限可以带过来：',
    '1. 点我的头像，加我为好友',
    `2. 在私聊里点输入框上方的「${BIND_ALIAS}」，再点发送`,
    oldSiliIsHere
      ? '3. 用你的旧 QQ 号（大号），把收到的绑定码发到本群就行'
      : '3. 用你的旧 QQ 号（大号），把收到的绑定码发到有旧 SILI 的群里',
    '⚠ 绑定码只能是你自己领的，别人给的不要发。',
  ].join('\n')
}

/** Channel fields carried over by group migration, when the model has them. */
const COPIED_FIELDS = [
  'enable',
  'disable',
  'mwApi',
  'userBlacklist',
  'locales',
  'permissions',
  'github.webhooks',
]

export class MigrationFeatures {
  private logger: Logger
  private menuDone = new Set<string>()

  constructor(
    private ctx: Context,
    private service: QQBotService
  ) {
    this.logger = ctx.logger('qqbot-migration')
    this.setupBind()
    this.setupMenu()
    this.setupGroupMigrate()
  }

  /**
   * Alias and copy for plugin-bind. Never `ctx.command('bind')` here: on an
   * existing command it re-parents the command's caller context to this
   * plugin. Take the instance from the commander, and catch the command when
   * plugin-bind registers it later (it waits for the database).
   */
  private setupBind() {
    const patch = (command: Command) => {
      if (command.name !== 'bind') return
      if (!(BIND_ALIAS in command._aliases)) command.alias(BIND_ALIAS)
      // i18n: the last definition wins, and plugin-bind defines its copy
      // before registering the command, so this lands after it.
      this.ctx.i18n.define('zh-CN', 'commands.bind', BIND_COPY)
    }
    const existing = this.ctx.$commander.get('bind')
    if (existing) patch(existing)
    this.ctx.on('command-added', patch)
  }

  /** DM menu with one button that fills the bind alias into the input box. */
  private setupMenu() {
    const apply = async (bot: Bot) => {
      if (bot.platform !== 'qq' || bot.status !== Universal.Status.ONLINE) return
      if (this.menuDone.has(bot.selfId)) return
      this.menuDone.add(bot.selfId)
      try {
        await (bot as any).internal.setMenu({
          menu: {
            items: [{ name: BIND_ALIAS, type: 'send_message', send_message: BIND_ALIAS }],
          },
        })
        this.logger.info('DM menu set for %s', bot.selfId)
      } catch (error) {
        this.menuDone.delete(bot.selfId)
        this.logger.warn('set DM menu', error)
      }
    }
    this.ctx.on('ready', () => this.ctx.bots.forEach((bot) => void apply(bot)))
    this.ctx.on('login-added', (session) => void apply(session.bot))
    this.ctx.on('login-updated', (session) => void apply(session.bot))
  }

  private setupGroupMigrate() {
    this.ctx
      .command(
        `${GROUP_MIGRATE_COMMAND} <oldGroup:string>`,
        '把旧群（OneBot）的设置迁移到当前群并激活',
        { authority: 4 }
      )
      .alias(GROUP_MIGRATE_ALIAS)
      .option('yes', '-y 确认执行')
      .action(async ({ session, options }, oldGroup) => {
        if (!session || session.platform !== 'qq' || session.isDirect) {
          return '请在要迁移到的新群里使用这条命令。'
        }
        oldGroup = oldGroup?.trim()
        if (!oldGroup || !/^\d+$/.test(oldGroup)) return '请提供旧群的 QQ 群号。'
        return this.migrateGroup(session, oldGroup, !!options?.yes)
      })
  }

  private async migrateGroup(session: Session, oldGroup: string, confirmed: boolean) {
    const { selfId, channelId } = session
    const db = this.ctx.database

    const done = await db.get('qqbot_migration', {
      kind: 'group',
      $or: [{ oldId: oldGroup }, { newId: channelId }],
    })
    if (done.length) {
      const d = done[0]
      return d.newId === channelId
        ? `当前群已经迁移过（来自旧群 ${d.oldId}），不能重复迁移。`
        : `旧群 ${oldGroup} 已经迁移到别的群了，不能重复迁移。`
    }

    const modelFields = this.ctx.model.tables.channel.fields
    const fields = COPIED_FIELDS.filter((f) => f in modelFields)
    const [old] = await db.get('channel', { platform: 'onebot', id: oldGroup }, fields as any)
    if (!old) return `找不到旧群 ${oldGroup} 的记录。`

    const present = fields.filter((f) => hasValue(readPath(old, f)))
    if (!confirmed) {
      const name = await this.groupName(session)
      return [
        `将把旧群 ${oldGroup} 的设置迁移到当前群「${name}」，并激活当前群。`,
        present.length ? `会复制：${present.join('、')}` : '旧群没有需要复制的设置，只会激活当前群。',
        `确认请发送：${GROUP_MIGRATE_COMMAND} ${oldGroup} -y`,
      ].join('\n')
    }

    const copied: Record<string, unknown> = {}
    for (const f of fields) copied[f] = readPath(old, f)
    await db.upsert('channel', [
      {
        platform: 'qq',
        id: channelId,
        ...copied,
        assignee: selfId,
        guildId: channelId,
        flag: 0,
        createdAt: new Date(),
      } as any,
    ])
    // The old OneBot row keeps no subscriptions, or v5 would keep pushing
    // GitHub events to a channel no bot serves.
    if ('github.webhooks' in modelFields) {
      await db.set('channel', { platform: 'onebot', id: oldGroup }, { 'github.webhooks': {} } as any)
      this.ctx.emit('github/rebuild-index')
    }
    await db.create('qqbot_migration', {
      kind: 'group',
      oldId: oldGroup,
      newId: channelId,
      selfId,
      operator: (session.user as any)?.id ?? 0,
      time: new Date(),
      fields: present,
    })

    // Result first, then the first-activation notice, both as passive replies.
    await session.send(
      `迁移完成：已复制 ${present.length ? present.join('、') : '（无）'}，当前群已激活。`
    )
    await this.service.activateGroup('qq', selfId, channelId, session)
  }

  private async groupName(session: Session) {
    try {
      const info = await (session.bot as any).internal.getGroupInfo(session.channelId)
      return info?.group_name || session.channelId
    } catch {
      return session.channelId
    }
  }
}

function readPath(obj: any, path: string) {
  return path.split('.').reduce((value, key) => value?.[key], obj)
}

function hasValue(value: unknown) {
  if (value == null) return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value as object).length > 0
  return value !== ''
}
