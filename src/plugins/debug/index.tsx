import { Context, h } from 'koishi'

import BasePlugin from '~/_boilerplate'

export class PluginDebug extends BasePlugin {
  constructor(ctx: Context) {
    super(ctx, {}, 'plugin-debug')

    ctx.command('debug', 'SILI debug commands', { authority: 3, hidden: true })

    ctx.inject(['piggyback'], (ctx) => {
      ctx
        .command('debug.piggyback <command:text>', 'Run as another user', {
          authority: 4,
        })
        .alias('debug.runas')
        .option('user', '-u <user:user>')
        .action(({ session, options }, command) => {
          if (!command) return session.execute('help debug.piggyback')

          const { user } = options
          if (!user) return 'No user specified.'
          const index = user.indexOf(':')
          const uin = user.slice(index + 1)
          if (uin === session.userId) {
            return 'You cannot piggyback to yourself.'
          }
          session.executeAsUser(uin, command)
        })
    })

    ctx
      .platform('onebot')
      .command('debug.face <faceId:posint>', 'Send QQ face', {})
      .action((_, faceId) => {
        if (isNaN(faceId) || faceId < 1) return 'Invalid face ID.'
        return <face id={faceId} />
      })

    ctx.inject(['qqntEmojiReaction'], (ctx) => {
      ctx
        .platform('onebot')
        .command('debug.reaction', 'Emoji reaction', {})
        .option('add', '-a <faceId:posint> Add reaction')
        .option('remove', '-r <faceId:posint> Remove reaction')
        .example(
          'If no action is specified, it will fetch the reactions from the message'
        )
        .action(({ session, options }) => {
          const msgId = session.quote?.id || session.messageId
          if (options.add) {
            return session
              .setReaction?.(options.add.toString())
              .then(() => '')
              .catch((e) => {
                return '失败：' + e.message
              })
          } else if (options.remove) {
            return session
              .removeReaction?.(options.remove.toString())
              .then(() => '')
              .catch((e) => {
                return '失败：' + e.message
              })
          } else {
            return this.ctx.qqntEmojiReaction
              .fetchReactions(msgId, session)
              .then((reactions) => {
                return JSON.stringify(reactions, null, 2)
              })
              .catch((e) => {
                return '失败：' + e.message
              })
          }
        })
    })

    ctx.inject(['html'], (ctx) => {
      ctx
        .command('debug.inspect', 'Inspect session data', {
          authority: 3,
        })
        .action(async ({ session }) => {
          if (!session.quote) return 'No quote found.'
          const img = await ctx.html.shiki(
            JSON.stringify(session.quote, null, 2),
            'json'
          )
          return img ? h.img(img, 'image/jpeg') : 'Failed to render.'
        })
    })

    ctx
      .platform('onebot')
      .command(
        'debug.history [count:posint]',
        'Probe NapCat group msg history',
        { authority: 3 }
      )
      .option('group', '-g <groupId:string>')
      .option('seq', '-s <messageSeq:posint>')
      .option('raw', '-r Render first 2 messages as JSON image')
      .action(async ({ session, options }, count) => {
        const groupId = options.group || session.guildId
        if (!groupId) return 'No group specified and not in a guild.'

        const params: Record<string, unknown> = {
          group_id: Number(groupId),
          count: count ?? 20,
          reverse_order: true,
        }
        if (options.seq) params.message_seq = options.seq

        const onebot = (session.bot as any).internal
        try {
          const res = await onebot._request('get_group_msg_history', params)
          const messages = res?.data?.messages ?? res?.messages ?? []
          const summary = [
            `status: ${res?.status ?? 'n/a'}, retcode: ${res?.retcode ?? 'n/a'}`,
            `count returned: ${messages.length}`,
            `params: ${JSON.stringify(params)}`,
          ].join('\n')
          if (!options.raw) return summary
          const sample = messages.slice(0, 2)
          const json = JSON.stringify(sample, null, 2)
          if (!ctx.html) return `${summary}\n---\n${json}`
          const img = await ctx.html.shiki(json, 'json')
          return img ? (
            <>
              {summary}
              {'\n'}
              {h.img(img, 'image/jpeg')}
            </>
          ) : (
            `${summary}\n---\n${json}`
          )
        } catch (e: any) {
          return `failed: ${e?.message ?? String(e)}`
        }
      })

    ctx
      .command('debug.event', 'Inspect session event data', { authority: 3 })
      .action(({ session }) => {
        const ev = session.event || session.toJSON()
        if (!ev) return 'No event data found.'
        return JSON.stringify(ev, null, 2)
      })

    ctx
      .command('debug.forward', 'Test forward message', { authority: 3 })
      .action(({ session }) => {
        return (
          <message forward>
            <message user_id={session.userId} nickname={session.username}>
              {session.content}
            </message>
            <message user_id={session.bot.userId} nickname={'BOT'}>
              Hi! This message is from the bot.
            </message>
          </message>
        )
      })
  }
}
