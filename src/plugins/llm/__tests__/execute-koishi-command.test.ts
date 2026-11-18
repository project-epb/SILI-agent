import { describe, expect, it } from 'vitest'

import { runExecuteKoishiCommand } from '../tools/execute-koishi-command'

describe('runExecuteKoishiCommand', () => {
  it('reports a command whose plugin cannot see this session', async () => {
    let executed = false
    const session: any = {
      app: { $commander: { get: () => ({ ctx: { filter: () => false } }) } },
      execute: async () => { executed = true; return [] },
    }
    const out = await runExecuteKoishiCommand(session, { name: 'pixiv' } as any, {} as any)
    expect(out).toMatch(/not available in this chat/)
    expect(executed).toBe(false)
  })
})
