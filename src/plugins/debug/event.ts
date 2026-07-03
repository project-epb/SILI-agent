import { Context } from 'koishi'

import BasePlugin from '~/_boilerplate'

/** `debug.event` — dump `session.event` (satori event payload) as JSON. */
export default class DebugEvent extends BasePlugin {
  constructor(ctx: Context) {
    super(ctx, {}, 'debug-event')

    ctx
      .command('debug.event', 'Inspect session event data', { authority: 3 })
      .action(({ session }) => {
        const ev = session.event || session.toJSON()
        if (!ev) return 'No event data found.'
        return JSON.stringify(ev, null, 2)
      })
  }
}
