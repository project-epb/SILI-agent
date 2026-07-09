import type { Context, Session } from '@koishijs/core'

import type { QueQiaoMinecraftBot } from '@/adapters/queqiao-minecraft'

import BasePlugin from '~/_boilerplate'

import type OneBotBot from 'koishi-plugin-adapter-onebot'

export class MinecraftConnect extends BasePlugin {
  constructor(
    public ctx: Context,
    options: { qqChannelId: string; mcServerId: string }[] = []
  ) {
    super(ctx, options, 'mc-connect')

    const mappings = Array.isArray(options)
      ? options.filter((m) => m?.qqChannelId && m?.mcServerId)
      : []

    if (!mappings.length) {
      this.logger.error(
        'MinecraftConnect plugin requires options: { qqChannelId: string; mcServerId: string }[]'
      )
      return
    }

    const getMcBot = (mcServerId: string) => {
      return this.ctx.bots.find((bot) => {
        if (bot.platform !== 'minecraft') return false
        const mcBot = bot as unknown as QueQiaoMinecraftBot<Context>
        return mcBot?.config?.serverName === mcServerId
      }) as QueQiaoMinecraftBot<Context>
    }
    const getQqBot = () => {
      return this.ctx.bots.find(
        (bot) => bot.platform === 'onebot'
      ) as OneBotBot<Context>
    }

    ctx.on('message', (session: Session) => {
      // MC -> QQ
      if (session.bot.platform === 'minecraft') {
        const qqBot = getQqBot()
        if (!qqBot) return this.logger.warn('No OneBot bot connected.')

        const mcServerId = session.channelId || session.guildId
        const targets = mappings.filter((m) => m.mcServerId === mcServerId)
        if (!targets.length) return

        const referrer = (session.event as any)?.referrer
        const rawCandidate =
          referrer?.message != null ? referrer?.message : referrer?.raw_message

        const tryParseMaybeJson = (value: unknown): unknown => {
          if (typeof value !== 'string') return value
          const trimmed = value.trim()
          if (!trimmed) return value
          if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
          try {
            return JSON.parse(trimmed)
          } catch {
            return value
          }
        }

        let content: any = session.content
        const parsed = tryParseMaybeJson(rawCandidate)
        if (parsed && (typeof parsed === 'object' || Array.isArray(parsed))) {
          const mcBot = session.bot as QueQiaoMinecraftBot<Context>
          try {
            content = mcBot.fromMinecraftTextComponents(parsed)
          } catch {
            // keep fallback
          }
        }

        for (const target of targets) {
          qqBot.sendMessage(
            target.qqChannelId,
            `[MC] ${session.username}:\n${String(content ?? '')}`
          )
        }
      }

      // QQ -> MC
      if (session.bot.platform === 'onebot') {
        const mapping = mappings.find(
          (m) => m.qqChannelId === session.channelId
        )
        if (!mapping) return

        const mcBot = getMcBot(mapping.mcServerId)
        if (!mcBot)
          return this.logger.warn(
            `No Minecraft bot connected for server: ${mapping.mcServerId}`
          )

        let message: any
        try {
          message = mcBot.toMinecraftTextComponents(session.content)
        } catch {
          message = [{ text: mcBot.pruneMessage(session.content) }]
        }

        const components = mcBot.createSenderSpeakComponents(message, {
          username: `${session.username}@QQ`,
          color: 'green',
          hover: { text: String(session.userId || '') },
        })

        mcBot.sendMessage('broadcast', components, undefined, { raw: true })
      }
    })

    for (const mapping of mappings) {
      const qqCtx = ctx.platform('onebot').channel(mapping.qqChannelId)

      // 太吵了，先关掉
      // ctx.on('guild-member-added', (session: Session) => {
      //   if (session.bot.platform !== 'minecraft') return
      //   const qqBot = getQqBot()
      //   if (!qqBot) return this.logger.warn('No OneBot bot connected.')
      //   qqBot.sendMessage(mapping.qqChannelId, `${session.username} 加入了游戏~`)
      // })
      // ctx.on('guild-member-removed', (session: Session) => {
      //   if (session.bot.platform !== 'minecraft') return
      //   const qqBot = getQqBot()
      //   if (!qqBot) return this.logger.warn('No OneBot bot connected.')
      //   qqBot.sendMessage(mapping.qqChannelId, `${session.username} 退出了游戏~`)
      // })

      qqCtx
        .command('queqiao/rcon <cmd...>', '通过 Minecraft 服务器执行指令', {
          authority: 4,
        })
        .action(async ({ session }, cmd) => {
          const mcBot = getMcBot(mapping.mcServerId)
          if (!mcBot) return session.text('无法找到 Minecraft 机器人。')
          const command = Array.isArray(cmd) ? cmd.join(' ') : String(cmd || '')
          const output = await mcBot.rconCommand(command)
          return output || 'OK'
        })
      qqCtx
        .command('queqiao/list', '列出在线玩家', {})
        .alias('在线玩家')
        .action(async ({ session }) => {
          const mcBot = getMcBot(mapping.mcServerId)
          if (!mcBot) return session.text('无法找到 Minecraft 机器人。')
          const resp = await mcBot.rconCommand('list')
          return resp || '无法获取在线玩家列表。'
        })
    }
  }

  pruneMinecraftRawText(text: string) {
    const input = text?.toString?.() ?? ''
    const trimmed = input.trim()

    const extract = (value: unknown): string => {
      if (value == null) return ''
      if (typeof value === 'string') return value
      if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value)
      }
      if (Array.isArray(value)) return value.map(extract).join('')

      if (typeof value === 'object') {
        const obj: any = value
        let acc = ''
        if (typeof obj.text === 'string') acc += obj.text
        else if (typeof obj.content === 'string') acc += obj.content

        if (!acc && typeof obj.translate === 'string' && obj.with) {
          acc += extract(obj.with)
        }

        if (obj.extra) acc += extract(obj.extra)
        return acc
      }

      return String(value)
    }

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed)
        const out = extract(parsed)
        return out || input
      } catch {
        // ignore
      }
    }

    return input
  }
}
