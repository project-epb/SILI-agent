/**
 * @name HelpAuthorityHint
 * @desc `help <指令>` 查询无权调用的指令时，说明是哪条指令没权限
 *
 * plugin-help 在目标指令的 `command:xxx` 权限检查失败时回 `internal.low-authority`
 * （「权限不足」），用户会以为是 help 本身没权限。被 koishi-plugin-switch 禁用的
 * 指令也走这条权限检查。这里在 help 执行前用同一套检查抢先回复。
 * 不要改全局的 `internal.low-authority` 文案：所有指令共用它。
 */
import { Context } from 'koishi'

import BasePlugin from '~/_boilerplate'

export default class HelpAuthorityHint extends BasePlugin {
  constructor(public ctx: Context) {
    super(ctx, {}, 'help-authority-hint')

    ctx.before('command/execute', async ({ session, command, args }) => {
      if (command.name !== 'help' || !session || !args[0]) return
      const target = ctx.$commander.resolve(String(args[0]), session)
      if (!target) return
      if (await ctx.permissions.test(`command:${target.name}`, session)) return
      return `你无权使用 ${target.displayName} 指令。`
    })
  }
}
