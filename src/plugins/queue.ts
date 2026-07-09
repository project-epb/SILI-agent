/**
 * @name PluginQueue
 * @command queue
 * @desc 指令队列
 * @authority 3
 */
import { Context, sleep } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

export default class PluginQueue extends BasePlugin {
  constructor(ctx: Context) {
    super(ctx, {}, 'queue')

    ctx
      .command('admin/queue <commands:text>', '指令队列', { authority: 3 })
      .option('interval', '-i <ms:posint>', { fallback: 1000 })
      .action(async ({ session, options }, commands) => {
        if (!commands) return
        const cmdList = commands.split('\n')
        async function ex(list: string[], index: number) {
          const cmd = list[index]
          if (cmd) {
            await session!.execute(cmd)
          }
          if (index + 1 < list.length) {
            await sleep(options?.interval || 1000)
            await ex(list, index + 1)
          }
        }
        ex(cmdList, 0)
      })
  }
}
