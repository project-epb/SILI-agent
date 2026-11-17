import type { Session } from 'koishi'

import { getUserRoles } from '@/utils/formatSession'

/**
 * Which conversation a message belongs to. A QQ group shares one
 * conversation among all members; everything else (DMs, other platforms)
 * keeps one conversation per user.
 *
 * The current conversation id lives on the group's channel row or on the
 * user row, so commands that read or reset it must load
 * `openai_last_conversation_id` through channelFields / userFields.
 */
export interface ConversationScope {
  /** True for a group-shared conversation. */
  shared: boolean
  /** ActiveChatRegistry key: the user id, or `group:<platform>:<channel>`. */
  key: string | number
  /** `openai_chat.conversation_owner`: the user id, or 0 for a group. */
  owner: number
  /** `openai_session.user_id`: the platform user id, or the channel id. */
  sessionUserId: string
  readonly conversationId: string
  setConversationId(id: string): Promise<void>
}

export const GROUP_CONVERSATION_OWNER = 0

export function isSharedGroup(session: Pick<Session, 'platform' | 'isDirect'>) {
  return session.platform === 'qq' && !session.isDirect
}

export function resolveConversationScope(session: Session): ConversationScope {
  if (isSharedGroup(session)) {
    const channel = session.channel as any
    return {
      shared: true,
      key: `group:${session.platform}:${session.channelId}`,
      owner: GROUP_CONVERSATION_OWNER,
      sessionUserId: session.channelId!,
      get conversationId() {
        return channel?.openai_last_conversation_id ?? ''
      },
      async setConversationId(id: string) {
        channel.openai_last_conversation_id = id
        await channel.$update()
      },
    }
  }
  const user = session.user as any
  return {
    shared: false,
    key: user.id,
    owner: user.id,
    sessionUserId: session.userId!,
    get conversationId() {
      return user?.openai_last_conversation_id ?? ''
    },
    async setConversationId(id: string) {
      user.openai_last_conversation_id = id
      await user.$update()
    },
  }
}

/** QQ group roles allowed to reset the conversation their group shares. */
const GROUP_RESET_ROLES = ['owner', 'admin']
const GROUP_RESET_AUTHORITY = 2

/**
 * Resetting a group conversation wipes everyone's context, so it takes a
 * group owner/admin or a SILI moderator.
 */
export function canResetGroupConversation(session: Session): boolean {
  if (((session.user as any)?.authority ?? 0) >= GROUP_RESET_AUTHORITY) return true
  return getUserRoles(session).some((r) => GROUP_RESET_ROLES.includes(r.id))
}
