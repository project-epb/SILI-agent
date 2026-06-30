/**
 * 鬼知道为什么不同的适配器返回的结果都不一样
 * 增加一些鲁棒性
 */
import { Fragment, Session, Universal } from 'koishi'

export function getUserIdFromSession(session: any): string {
  // @ts-ignore
  return session.userId || session.member?.id || session.user?.id
}
export function getUserNickFromSession(session: any): string {
  // @ts-ignore
  return (
    session.username ||
    session.member?.nick ||
    session.user?.name ||
    getUserIdFromSession(session)
  )
}

export function getChannelIdFromSession(session: any): string {
  // @ts-ignore
  return session.channelId || session.channel?.id
}
export function getChannelNameFromSession(session: any): string {
  // @ts-ignore
  return (
    session.channel?.name ||
    session.guild?.name ||
    getChannelIdFromSession(session)
  )
}

export function getGuildIdFromSession(session: any): string {
  // @ts-ignore
  return session.guildId || session.guild?.id
}
export function getGuildNameFromSession(session: any): string {
  // @ts-ignore
  return session.guild?.name || getChannelNameFromSession(session)
}

/**
 * 稳定的角色形状：id 必填，其余字段对齐 satori GuildRole 但一律可选。
 * 屏蔽 satori 在 GuildRole 字段可选性、以及 GuildMember.roles 元素类型
 * （string[] ↔ GuildRole[]）上的跨版本抖动。
 */
export type UserRole = Partial<Universal.GuildRole> & { id: string }

/**
 * 归一化任意适配器 / satori 版本下的成员角色为 UserRole[]。
 * - 旧 satori：roles 是 string[]（如 `['admin']`）→ 包装成 `[{ id: 'admin' }]`
 * - 新 satori：roles 是 GuildRole[]（如 `[{ id: 'admin', name }]`）→ 原样透传
 * - 缺失 / 非数组 → `[]`
 */
export function getUserRoles(session: any): UserRole[] {
  const raw =
    // @ts-ignore 各适配器返回的字段路径不一，宽松取值
    session?.author?.roles ??
    session?.member?.roles ??
    session?.event?.member?.roles
  if (!Array.isArray(raw)) return []
  return raw
    .map((r: any): UserRole => (typeof r === 'string' ? { id: r } : r))
    .filter(
      (r: any): r is UserRole =>
        r != null && typeof r.id === 'string' && r.id.length > 0
    )
}

/**
 * 判断当前会话用户是否拥有指定角色（传数组时命中任一即真）。
 * 同时匹配 GuildRole 的 `id` 与 `name`（onebot 把角色串放在 `id`，
 * 其它适配器可能放在 `name`）。大小写敏感。
 */
export function checkUserHasRole(
  session: any,
  role: string | string[]
): boolean {
  const wanted = Array.isArray(role) ? role : [role]
  return getUserRoles(session).some((r) =>
    wanted.some((w) => r.id === w || r.name === w)
  )
}

export async function sendMessageBySession(
  session: Session,
  message: Fragment,
  options?: any
) {
  return session.bot.sendMessage(
    getChannelIdFromSession(session),
    message,
    getGuildIdFromSession(session),
    options
  )
}
