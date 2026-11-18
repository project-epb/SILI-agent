// From @koishijs/core, never 'koishi': importing koishi under vitest loads
// @koishijs/loader, which crashes at import time and fails the whole file.
import { Context } from '@koishijs/core'

import { describe, expect, it } from 'vitest'

import CommandPermissions from '../CommandPermissions'

function setup() {
  const ctx = new Context()
  ctx.command('channel', { authority: 3 })
  ctx.plugin(CommandPermissions)
  ctx.command('channel.mute', { authority: 3, permissions: ['group:admin'] })
  ctx.command('channel.locale', { authority: 3 })
  return ctx
}

const who = (authority: number, roles: string[], isDirect = false): any => ({
  user: { authority },
  isDirect,
  event: { member: { roles } },
})

describe('CommandPermissions', () => {
  it('lets group admins or enough authority through, and no one else', async () => {
    const ctx = setup()
    const can = (s: any) => ctx.permissions.test('command:channel.mute', s)
    expect(await can(who(1, ['admin']))).toBe(true)
    expect(await can(who(1, ['owner']))).toBe(true)
    expect(await can(who(3, []))).toBe(true)
    expect(await can(who(1, ['member']))).toBe(false)
    expect(await can(who(1, ['admin'], true))).toBe(false)
  })

  it('opens only the parent, not its other subcommands', async () => {
    const ctx = setup()
    expect(
      await ctx.permissions.test('command:channel.locale', who(1, ['admin']))
    ).toBe(false)
  })
})
