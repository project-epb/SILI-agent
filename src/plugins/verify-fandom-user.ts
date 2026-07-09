/**
 * @name PluginVerifyFandomUser
 * @command verify-qq
 * @desc Fandom编辑者QQ群入群检测
 * @authority 1
 */
import { Context, Session, segment } from '@koishijs/core'

import crypto from 'node:crypto'

import BasePlugin from '~/_boilerplate'

import fexios from 'fexios'

declare module 'koishi' {
  export interface Channel {
    userBlacklist: string[]
  }
}

export default class PluginVerifyFandomUser extends BasePlugin {
  constructor(ctx: Context) {
    super(ctx, {}, 'verify-fandom-user')

    ctx = ctx.channel()
    ctx.model.extend('channel', {
      userBlacklist: 'list',
    })

    // 指令
    ctx
      .command('verify-qq', '验证Fandom用户QQ信息')
      .option('qq', '-q <qq:string>')
      .option('user', '-u <user:string>')
      .action(async ({ session, options }) => {
        const { msg } = await this.verifyQQ(
          session as Session,
          options as { user?: string; qq?: string }
        )
        return msg
      })

    ctx
      .channel(
        '' + process.env.CHANNEL_QQ_FANDOM,
        '' + process.env.CHANNEL_QQ_SANDBOX
      )
      .on('guild-member-request', async (session) => {
        const { userId, content } = session
        const answer = content?.split('答案：')[1] || ''

        await session.send(`!verify-qq --qq ${userId} --user ${answer.trim()}`)

        let msg: string, status: boolean
        try {
          const verify = await this.verifyQQ(session, {
            qq: userId,
            user: answer.trim(),
          })
          msg = verify.msg
          status = verify.status
        } catch (err) {
          this.logger.warn(err)
          return `查询时遇到错误：${err.message}`
        }

        session.sendQueued(msg)
        if (status) {
          try {
            await session.bot.handleGuildMemberRequest(
              session.messageId as string,
              true
            )
            session.sendQueued('已自动通过入群申请。')
          } catch (err) {
            session.sendQueued(`自动通过入群申请时遇到错误：${err}`)
          }
        } else {
          session.sendQueued(
            [
              '请手动检查该用户信息，复制拒绝理由:',
              'QQ号验证失败，请参阅群说明',
            ].join('\n')
          )
        }
      })
  }

  async verifyQQ(session: Session, options: { user?: string; qq?: string }) {
    let msg = '',
      status = false

    if (!options.user) {
      msg = '× 验证失败\n未指定用户名'
      return { msg, status }
    }

    const { userBlacklist } = await this.ctx.database.getChannel(
      session.platform,
      session.channelId as string,
      ['userBlacklist']
    )

    if (userBlacklist?.includes(session.userId as string)) {
      msg = '× 验证失败\n该聊天账号位于群黑名单。'
      return { msg, status }
    }

    // 缓存变量
    let userName = options.user,
      qqNumber = options.qq || session.userId?.replace('onebot:', '')

    // 修正用户名：去除首尾空格
    userName = userName.trim()
    // 修正用户名：去除`User:`前缀
    userName = userName.replace(/^user:/i, '')
    // 修正用户名：替换空格为下划线
    userName = userName.replace(/[_\s]+/g, '_')
    // 修正用户名：首字母大写
    userName = userName.slice(0, 1).toUpperCase() + userName.slice(1)

    const { data } = await this.ajax.get('', {
      query: {
        action: 'query',
        titles: `User:${userName}/qq-hash`,
        prop: 'info|revisions',
        inprop: 'varianttitles',
        rvprop: 'ids|timestamp|flags|comment|user|content',
      },
    })

    const page = data?.query?.pages?.[0]
    if (!page || page.missing) {
      msg = `[${segment.at(
        qqNumber as string
      )}↔${userName}] \n× 验证失败\n页面 User:${userName}/qq-hash 不存在！`
      return { msg, status }
    }

    const lastRev = page.revisions[0]
    if (!lastRev || lastRev.user.replace(/[\s_]+/g, '_') !== userName) {
      msg = `[${segment.at(
        qqNumber as string
      )}↔${userName}] \n× 验证失败\n验证代码的最后编辑者不是用户本人！`
      return { msg, status }
    }

    const [verifyTime, verifyName, verifyHash] = lastRev.content.split('#')

    if (!verifyTime || !verifyName || !verifyHash) {
      msg = `[${segment.at(
        qqNumber as string
      )}↔${userName}] \n× 验证失败\n验证代码格式错误！`
      return { msg, status }
    }

    const now = Date.now()
    // verifyTime 必须在2小时以内
    if (now - parseInt(verifyTime) > 2 * 60 * 60 * 1000) {
      msg = `[${segment.at(
        qqNumber as string
      )}↔${userName}] \n× 验证失败\n验证代码已过期！`
      return { msg, status }
    }

    const promptQqHash = await this.sha1(
      `${verifyTime}#${userName}#${qqNumber}`
    )
    if (promptQqHash !== verifyHash) {
      msg = `[${segment.at(
        qqNumber as string
      )}↔${userName}] \n× 验证失败\n保存在wiki中的验证代码与QQ号不匹配。`
      return { msg, status }
    }

    status = true
    msg = `[${segment.at(qqNumber as string)}↔${userName}] \n√ 验证通过！`

    return { msg, status }
  }

  get ajax() {
    return fexios.create({
      baseURL: 'https://community.fandom.com/zh/api.php',
      query: {
        format: 'json',
        formatversion: '2',
      },
    })
  }

  async sha1(str: string): Promise<string> {
    const data = await crypto.subtle.digest(
      'SHA-1',
      new TextEncoder().encode(str)
    )
    return Array.from(new Uint8Array(data))
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('')
  }
}
