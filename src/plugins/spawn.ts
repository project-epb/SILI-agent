import { Context, Service, Time } from '@koishijs/core'

import { ExecOptions, exec } from 'node:child_process'

import BasePlugin from '~/_boilerplate'

declare module 'koishi' {
  export interface Context {
    shell: ShellService
  }
}

export class ShellService extends Service {
  constructor(public ctx: Context) {
    super(ctx, 'shell')
  }
  makeProcess(cmd: string, options?: ExecOptions) {
    return exec(cmd, {
      cwd: this.ctx.baseDir,
      windowsHide: true,
      encoding: 'utf-8',
      timeout: 1 * Time.minute,
      ...options,
    })
  }
  exec(
    cmd: string,
    onStdout?: (data: string) => void,
    options?: ExecOptions
  ): Promise<{ code: number; signal: NodeJS.Signals; output: string }> {
    return new Promise((resolve, reject) => {
      const process = this.makeProcess(cmd, options)
      let output = ''
      process.stdout?.on('data', (data) => {
        output += data
        onStdout?.(data)
      })
      process.on('exit', (code, signal) => {
        ;(code === 0 ? resolve : reject)({ code, signal, output })
      })
    })
  }
}

export default class PluginSpawn extends BasePlugin {
  constructor(ctx: Context, config?: ExecOptions) {
    super(ctx, config, 'spawn')
    ctx.plugin(ShellService)

    ctx
      .command('admin/spawn <cmd:text>', '执行终端命令', { authority: 4 })
      .alias('sh')
      .action(async ({ session }, cmd) => {
        if (!cmd) return session?.execute('spawn -h')
        const startTime = Date.now()
        await session.send('[SPAWN] > ' + cmd)
        const res = await ctx.shell.exec(
          cmd,
          (data) => {
            session?.sendQueued(data)
          },
          config
        )
        return `[SPAWN] 命令执行完毕
耗时 ${((Date.now() - startTime) / 1000).toFixed(2)}s
退出码 ${res.code}
终止信号 ${res.signal}`
      })
  }
}
