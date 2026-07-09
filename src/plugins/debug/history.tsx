import { Context, h } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

/** `debug.history` — probe NapCat's `get_group_msg_history`; `-r` renders a JSON sample. */
export default class DebugHistory extends BasePlugin {
  constructor(ctx: Context) {
    super(ctx, {}, 'debug-history')

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
  }
}
