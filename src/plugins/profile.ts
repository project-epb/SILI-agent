/**
 * @name PluginProfile
 * @command profile
 * @desc 基本资料
 * @authority 1
 */
import { Context, Session, User, h } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

import { BulkMessageBuilder } from '$utils/BulkMessageBuilder'

export default class PluginProfile extends BasePlugin {
  constructor(ctx: Context) {
    super(ctx, null, 'profile')

    ctx
      .command('admin/profile', '个人资料', {})
      .alias('admin/whoami')
      .option('user', '-u <user:string> platform:uid', { authority: 2 })
      .action(async ({ session, options }) => {
        if (!session) return
        let user: User
        const authorUniqId = `${session.platform}:${session.userId}`
        let platform: string, uid: string
        if (options.user) {
          ;[platform, uid] = options.user.split(':')
          if (!uid) {
            uid = platform
            platform = session.platform
          }
        } else {
          platform = session.platform
          uid = session.userId
        }
        const isTargetEqualAuthor = `${platform}:${uid}` === authorUniqId
        console.info(platform, uid, authorUniqId, isTargetEqualAuthor)
        user = await session.app.database.getUser(platform, uid, [
          'id',
          'authority',
          'name',
          // @ts-ignore
          'github.accessToken',
        ])
        if (!user) return 'SILI没有找到这个用户'
        const bindings = await session.app.database.get('binding', {
          aid: user.id,
        })
        const curPlatformBinding = bindings.find(
          (i) => i.platform === session.platform
        )
        const nickname = user?.name ? h.escape(user?.name) : ''
        const isBoundText = (i: boolean) => (i ? '√ 已绑定' : '× 未绑定')
        const isPlatformBoundText = (platform: string) => {
          return isBoundText(!!bindings.find((i) => i.platform === platform))
        }
        const msgBuilder = new BulkMessageBuilder(session as Session)
        msgBuilder
          .prependOriginal()
          .botSay(
            `${isTargetEqualAuthor ? '个人' : '他人'}资料\n平台ID: ${
              curPlatformBinding.pid
            }\n平台昵称/群名片: ${(user as any)?.nickname || ''}`
          )
          .botSay(`UID: ${user.id}`)
          .botSay(`SILI称${isTargetEqualAuthor ? '你' : 'TA'}为: ${nickname}`)
          .botSay(`权限: ${user.authority || 0}`)
          .botSay(
            [
              `账号绑定情况:`,
              `${isPlatformBoundText('onebot')} QQ`,
              `${isPlatformBoundText('qqguild')} QQ频道`,
              `${isPlatformBoundText('discord')} Discord`,
              `${isPlatformBoundText('kooka')} Kook`,
              `${isPlatformBoundText('villa')} 大别野`,
              `${isPlatformBoundText('dingtalk')} 钉钉`,
              `${isBoundText(!!user?.github?.accessToken)} GitHub`,
            ].join('\n')
          )
        return msgBuilder.all()
      })
  }
}
