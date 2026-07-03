import { Context, h } from 'koishi'

import BasePlugin from '~/_boilerplate'

/** `debug.inspect` — render a quoted message's `session.quote` as a JSON image. */
export default class DebugInspect extends BasePlugin {
  static inject = ['html']

  constructor(ctx: Context) {
    super(ctx, {}, 'debug-inspect')

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
  }
}
