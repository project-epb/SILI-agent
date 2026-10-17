/**
 * @name SilentSwitch
 * @desc 让被 koishi-plugin-switch 禁用的指令在所有调用路径上都静默
 *
 * switch 只在 `attach` 事件里把禁用指令的 response 置为 noop，这只覆盖
 * 「消息直接解析成指令」的路径。经 `session.execute` 进来的调用 ——
 * shortcut（例如 chat 的 `xxx?`）、FallbackHandler 兜底转 chat —— 不走
 * attach，会落到 core 的权限校验，失败后回一句 `internal.low-authority`，
 * 在禁用了该指令的群里反复刷屏。
 *
 * 这里抢在 core 权限校验之前（prepend）用同一套规则判断，命中就返回 `''`
 * 静默中止。必须保持 prepend：排在 core 之后就已经发过提示了。
 */
import { Command, Context } from 'koishi'

import BasePlugin from '~/_boilerplate'

interface SwitchFields {
  enable?: string[]
  disable?: string[]
}

/** 与 koishi-plugin-switch 的 `switch:(value)` 权限判定保持一致 */
export function isSwitchedOff(
  command: Pick<Command, 'name' | 'config' | 'parent'> | null | undefined,
  channel: SwitchFields | null | undefined
): boolean {
  const { enable = [], disable = [] } = channel || {}
  while (command) {
    if (command.config.userCall === 'disabled') {
      if (!enable.includes(command.name)) return true
    } else if (disable.includes(command.name)) {
      return true
    }
    command = command.parent
  }
  return false
}

export default class SilentSwitch extends BasePlugin {
  constructor(public ctx: Context) {
    super(ctx, {}, 'silent-switch')

    ctx.before(
      'command/execute',
      ({ session, command }) => {
        if (!session || session.isDirect) return
        if (isSwitchedOff(command, session.channel as SwitchFields)) return ''
      },
      true
    )
  }
}
