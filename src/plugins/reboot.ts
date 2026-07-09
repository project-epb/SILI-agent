import { Context, Session, h } from '@koishijs/core'

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import BasePlugin from '~/_boilerplate'

import {
  getChannelIdFromSession,
  getGuildIdFromSession,
  getUserIdFromSession,
  getUserNickFromSession,
  sendMessageBySession,
} from '$utils/formatSession'
import { safelyStringify } from '$utils/safelyStringify'

enum LogFile {
  signal = '.koishi_signal',
  commandLogs = '.koishi_signal_cmdlogs',
  lastSession = '.koishi_signal_lastsession',
}
enum KSignal {
  isReboot = 1 << 0,
  isGitSync = 1 << 1,
  isFastReboot = 1 << 2,
  isDumpDB = 1 << 3,
}

type SessionLog = {
  kSignal: `${number}`
  options: any
  time: number
  session: Session
}

export default class PluginReboot extends BasePlugin {
  static inject = ['html']

  constructor(ctx: Context) {
    super(ctx, {}, 'reboot')

    this.initCommands()
    this.onAfterReboot()
  }

  private initCommands() {
    const ctx = this.ctx

    ctx
      .command('admin/reboot', '[tags:text] 重启机器人', { authority: 4 })
      .alias('restart', '重启')
      .option('sync', '-s 从 Git 同步并处理依赖')
      .option('dumpdb', '-d 备份数据库')
      .option('yes', '-y 跳过确认', { hidden: true })
      .action(async ({ session, options }, tags) => {
        tags ||= ''
        tags = tags.trim().toLowerCase()
        if (tags.includes('s')) {
          options.sync = true
        }
        if (tags.includes('d')) {
          options.dumpdb = true
        }
        if (tags.includes('y')) {
          options.yes = true
        }
        if (tags === 'sodayo' || tags === '硕大友') {
          options.sync = true
          options.dumpdb = true
          options.yes = true
        }

        if (!options.yes) {
          await session.send('请在 10 秒内发送句号以确认重启……')
          const ensure = await (session as Session).prompt(10 * 1000)
          if (!['.', '。', 'y'].includes(ensure)) {
            return 'SILI 驳回了重启申请。'
          }
        }

        let kSignal = 0
        kSignal |= KSignal.isReboot
        if (options.sync) kSignal |= KSignal.isGitSync
        kSignal |= KSignal.isFastReboot
        if (options.dumpdb) kSignal |= KSignal.isDumpDB

        await Promise.all([
          await this.writeLogFile(LogFile.signal, kSignal.toString()),
          await this.writeLogFile(
            LogFile.lastSession,
            safelyStringify({
              kSignal,
              options,
              time: Date.now(),
              session: {
                ...session.toJSON(),
                content: session.content,
              },
            })
          ),
        ])

        await session.send(
          `SILI 即将重新连接到智库...\nGitSync=${!!options.sync}; DumpDB=${!!options.dumpdb}`
        )
        process.exit(0)
      })
  }

  async readLogFile(file: LogFile): Promise<string | null> {
    const path = resolve(import.meta.dirname, '../../', file)
    try {
      const content = (await readFile(path)).toString()
      return content.trim() || null
    } catch (e) {
      return null
    }
  }
  async writeLogFile(file: LogFile, content: string) {
    const path = resolve(import.meta.dirname, '../../', file)
    await writeFile(path, content)
  }
  async removeLogFile(file: LogFile) {
    try {
      await this.writeLogFile(file, '')
    } catch (e) {}
  }

  private async onAfterReboot() {
    let lastSession!: SessionLog
    // 尝试读取最后的重启日志
    try {
      lastSession = JSON.parse(await this.readLogFile(LogFile.lastSession))
    } catch (_) {
      return console.info('未找到重启日志。')
    } finally {
      this.removeLogFile(LogFile.lastSession)
    }

    const cmdLogsRaw = await this.readLogFile(LogFile.commandLogs)
    let cmdLogsImg: Buffer | undefined
    if (cmdLogsRaw) {
      ;[cmdLogsImg] = await Promise.all([
        await this.ctx.root.html.hljs(cmdLogsRaw, 'shell'),
        await this.removeLogFile(LogFile.commandLogs),
      ])
    }

    if (lastSession && lastSession.session) {
      const now = Date.now()
      const { session, kSignal } = lastSession
      const bot = this.ctx.bots.find((i) => i.platform === session.platform)
      if (!bot) return console.info('未找到对应的机器人实例。')

      console.info(session)
      bot.sendMessage(
        getChannelIdFromSession(session),
        `SILI 已重新连接到智库
SIGNAL: ${(+kSignal).toString(2).padStart(6, '0')}
共耗时: ${((now - lastSession.time) / 1000).toFixed(2)}s
执行人: ${h.at(getUserIdFromSession(session), {
          name: getUserNickFromSession(session),
        })}
${cmdLogsImg ? h.image(cmdLogsImg, 'image/jpeg') : '(没有详细日志)'}`,
        getGuildIdFromSession(session)
      )
    }
  }
}
