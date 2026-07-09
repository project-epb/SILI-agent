import { Context } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

/** `debug.face` — send a raw QQ face by id. */
export default class DebugFace extends BasePlugin {
  constructor(ctx: Context) {
    super(ctx, {}, 'debug-face')

    ctx
      .platform('onebot')
      .command('debug.face <faceId:posint>', 'Send QQ face', {})
      .action((_, faceId) => {
        if (isNaN(faceId) || faceId < 1) return 'Invalid face ID.'
        return <face id={faceId} />
      })
  }
}
