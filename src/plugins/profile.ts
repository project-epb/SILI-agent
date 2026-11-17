/**
 * @name PluginProfile
 * @command profile
 * @desc 基本资料
 * @authority 1
 */
import { Context, Session, h } from 'koishi'

import BasePlugin from '~/_boilerplate'
import { markdownText } from '~/mediawiki/qq-reply'

/** Display names of binding platforms; unknown platforms show their raw name. */
const PLATFORM_NAMES: Record<string, string> = {
  qq: 'QQ',
  onebot: 'OneBot（旧 SILI 绑定）',
  qqguild: 'QQ 频道',
  discord: 'Discord',
  kook: 'KOOK',
  dingtalk: '钉钉',
  lark: '飞书',
  minecraft: 'Minecraft',
}

export default class PluginProfile extends BasePlugin {
  static inject = ['database']

  constructor(ctx: Context) {
    super(ctx, null, 'profile')

    ctx
      .command('admin/profile', '个人资料', {})
      .alias('admin/whoami')
      .option('user', '-u <user:string> platform:uid', { authority: 2 })
      .action(async ({ session, options }) => {
        if (!session) return
        let [platform, uid] = options?.user
          ? options.user.split(':')
          : [session.platform, session.userId!]
        if (!uid) [platform, uid] = [session.platform, platform]
        const isSelf = platform === session.platform && uid === session.userId

        const user = await ctx.database.getUser(platform, uid, [
          'id',
          'authority',
          'name',
          'github.accessToken' as any,
        ])
        if (!user) return 'SILI 没有找到这个用户'
        const bindings = await ctx.database.get('binding', { aid: user.id }, [
          'platform',
          'pid',
        ])
        const githubBound = !!(user as any).github?.accessToken

        return this.render(session, isSelf, [
          ['UID', String(user.id)],
          [
            `SILI 称${isSelf ? '你' : 'TA'}为`,
            this.callName(session, isSelf, user.name),
          ],
          ['权限', String(user.authority ?? 0)],
          null,
          ...bindings.map(
            ({ platform, pid }) =>
              [PLATFORM_NAMES[platform] ?? platform, pid] as [string, string]
          ),
          ['GitHub', githubBound ? '已绑定' : '未绑定'],
        ])
      })
  }

  /** Without callme, SILI uses the platform nickname, known only for oneself. */
  private callName(session: Session, isSelf: boolean, name?: string) {
    if (name) return name
    const nick = isSelf
      ? session.event.member?.nick || session.event.user?.name
      : ''
    return `${nick || ''}（未设置，使用平台昵称）`
  }

  /** `null` starts the bindings section. One Markdown message on QQ. */
  private render(
    session: Session,
    isSelf: boolean,
    rows: ([string, string] | null)[]
  ) {
    const title = isSelf ? '个人资料' : '他人资料'
    const split = rows.indexOf(null)
    const basic = rows.slice(0, split) as [string, string][]
    const bound = rows.slice(split + 1) as [string, string][]

    if (session.platform === 'qq') {
      const item = ([k, v]: [string, string]) =>
        `- ${markdownText(k)}：${markdownText(v)}`
      return h(
        'markdown',
        h.text(
          [
            `## ${title}`,
            ...basic.map(item),
            '',
            '### 账号绑定',
            ...bound.map(item),
          ].join('\n')
        )
      )
    }
    const item = ([k, v]: [string, string]) => `${k}：${v}`
    return h.text(
      [
        `【${title}】`,
        ...basic.map(item),
        '',
        '【账号绑定】',
        ...bound.map(item),
      ].join('\n')
    )
  }
}
