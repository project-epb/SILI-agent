import { Context } from 'koishi'

import BasePlugin from '~/_boilerplate'

import DebugEvent from './event'
import DebugInspect from './inspect'
import DebugPiggyback from './piggyback'
import DebugMarkdown from './render-markdown'

/**
 * `debug.*` — developer probes (authority 3+, hidden). Each subcommand is its
 * own koishi plugin (own scope + `static inject` deps); this plugin only
 * declares the parent command and mounts the subplugins via `ctx.plugin()`.
 */
export class PluginDebug extends BasePlugin {
  constructor(ctx: Context) {
    super(ctx, {}, 'plugin-debug')

    ctx.command('debug', 'SILI debug commands', { authority: 3, hidden: true })

    ctx.plugin(DebugPiggyback)
    ctx.plugin(DebugInspect)
    ctx.plugin(DebugMarkdown)
    ctx.plugin(DebugEvent)
  }
}
