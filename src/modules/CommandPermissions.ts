/**
 * @name CommandPermissions
 * @desc Command permissions written the Koishi way, minus two traps.
 *
 * `command:X` passes when ANY entry of X's `permissions` passes, so a command
 * a group's own owner and admins may also run reads:
 *
 *   ctx.command('foo', '说明', { authority: 3, permissions: ['group:admin'] })
 *
 * Trap 1: Koishi derives `['authority:3']` from `authority` only when
 * `permissions` is absent. Written as above, authority 3 would no longer let
 * anyone in, so a command with both and no `authority:*` entry gets
 * `authority:<n>` added here.
 *
 * Trap 2: every parent command must pass too. plugin-admin's bare `channel`
 * is authority 3, which would shut group admins out of every `channel.*`
 * subcommand; it only prints help, so it is opened to group admins here.
 * Other parents are not: opening a parent opens whatever it does itself, so
 * declare `group:admin` on them explicitly.
 */
import type { Command, Context, Session } from 'koishi'

import { getUserRoles } from '@/utils/formatSession'

export const GROUP_ADMIN = 'group:admin'

/** QQ group roles (`author.member_role`) that count as admins of the group. */
export const GROUP_ADMIN_ROLES = ['owner', 'admin']

/** Parent commands opened to group admins; see trap 2. */
const OPENED_PARENTS = ['channel']

export function isGroupAdmin(session: Session): boolean {
  if (session.isDirect) return false
  return getUserRoles(session).some((r) => GROUP_ADMIN_ROLES.includes(r.id))
}

function patch(command: Command) {
  const { config } = command
  const permissions = config.permissions ?? []
  if (
    typeof config.authority === 'number' &&
    !permissions.some((p) => p.startsWith('authority:'))
  )
    config.permissions = [...permissions, `authority:${config.authority}`]
  if (
    OPENED_PARENTS.includes(command.name) &&
    !config.permissions!.includes(GROUP_ADMIN)
  )
    config.permissions = [...config.permissions!, GROUP_ADMIN]
}

export default function CommandPermissions(ctx: Context) {
  ctx.permissions.provide(GROUP_ADMIN, (_, session) =>
    isGroupAdmin(session as Session)
  )
  for (const command of (ctx.$commander as any)._commandList) patch(command)
  ctx.on('command-added', patch)
}
