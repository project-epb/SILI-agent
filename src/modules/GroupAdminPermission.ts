/**
 * @name GroupAdminPermission
 * @desc Lets a group's own owner and admins run selected commands in that
 * group, besides users with enough authority.
 *
 * Koishi's `authority` only takes a number. Commands go through its
 * permission system instead: `command:X` passes when ANY entry of X's
 * `permissions` passes, so `['authority:3', 'group:admin']` reads "authority
 * 3, or an admin of this group". Use {@link authorityOrGroupAdmin}.
 *
 * Koishi also requires every parent command to pass. plugin-admin's bare
 * `channel` command is authority 3, which would shut group admins out of
 * every `channel.*` subcommand however it is declared; it only prints help,
 * so it is opened to group admins here. Its subcommands keep their own
 * permissions.
 */
import type { Command, Context, Session } from 'koishi'

import { getUserRoles } from '@/utils/formatSession'

export const GROUP_ADMIN = 'group:admin'

/** QQ group roles (`author.member_role`) that count as admins of the group. */
const ADMIN_ROLES = ['owner', 'admin']

/** Parent commands opened to group admins; see the module comment. */
const OPENED_PARENTS = ['channel']

export function isGroupAdmin(session: Session): boolean {
  if (session.isDirect) return false
  return getUserRoles(session).some((r) => ADMIN_ROLES.includes(r.id))
}

/**
 * Command config: runnable with `authority` or by an admin of the group it
 * is used in. `authority` stays set for help and anything that reads it.
 */
export function authorityOrGroupAdmin(authority: number) {
  return { authority, permissions: [`authority:${authority}`, GROUP_ADMIN] }
}

export default function GroupAdminPermission(ctx: Context) {
  ctx.permissions.provide(GROUP_ADMIN, (_, session) =>
    isGroupAdmin(session as Session)
  )
  const open = (command: Command) => {
    if (!OPENED_PARENTS.includes(command.name)) return
    const permissions = command.config.permissions ?? [
      `authority:${command.config.authority ?? 1}`,
    ]
    if (!permissions.includes(GROUP_ADMIN))
      command.config.permissions = [...permissions, GROUP_ADMIN]
  }
  for (const command of (ctx.$commander as any)._commandList) open(command)
  ctx.on('command-added', open)
}
