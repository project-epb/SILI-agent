import { Context } from 'koishi'

import { resolve } from 'node:path'

import {} from '@koishijs/console'

declare module '@koishijs/console' {
  interface Events {
    'llm-dashboard/ping'(): { message: string; time: number }
  }
}

export const name = 'llm-dashboard'
export const inject = ['console']

export function apply(ctx: Context) {
  // Spike endpoint: proves the client -> server data path (send / addListener).
  ctx.console.addListener('llm-dashboard/ping', () => ({
    message: 'hello from SILI backend',
    time: Date.now(),
  }))

  // Register the sidebar page. The entry is a hand-written ESM file served
  // as-is by the console (no vite / no build step); `../vue.js` & `../client.js`
  // are the console-provided shared runtime modules.
  //
  // NOTE: the console's asset guard only serves entry files whose resolved path
  // is under its own dist root OR contains "node_modules" (see plugin-console
  // serveAssets). So we MUST point at the workspace-symlinked node_modules copy,
  // not `import.meta.dirname` (which resolves to the real ./plugins path).
  const clientDir = resolve(
    ctx.baseDir,
    'node_modules/koishi-plugin-llm-dashboard/client'
  )
  ctx.console.addEntry({ dev: clientDir, prod: clientDir })
}
