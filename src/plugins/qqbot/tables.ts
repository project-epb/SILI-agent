import { Context } from 'koishi'

/** Full messages of served qq channels (activated groups, allowed DMs). */
export interface QQBotMessage {
  selfId: string
  /** Group openid, or `private:<openid>` for DMs. */
  channelId: string
  messageId: string
  userId: string
  username: string
  isBot: boolean
  /** Sent by this bot (the platform never pushes the bot's own messages back). */
  isSelf: boolean
  content: string
  /** User ids this message @-mentions. */
  mentions: string[]
  quoteId: string
  time: Date
}

/** Groups this bot has seen. Metadata only, never message content. */
export interface QQBotChannel {
  selfId: string
  /** Group openid. */
  id: string
  platform: string
  name: string
  memberNum: number
  /** Bot role in the group: member / admin / owner. */
  role: string
  /** all / only_mention / mention_and_context */
  recvSetting: string
  allowProactive: boolean
  /** Group admins turned the bot's messages off (`group-msg-reject`). */
  recvRejected: boolean
  /** Who added the bot (operator openid from GROUP_ADD_ROBOT). */
  addedBy: string
  firstSeen: Date
  lastSeen: Date
  messageCount: number
  removedAt: Date
  infoUpdatedAt: Date
  noticeSentAt: Date
  /** First-activation notice still owed, sent on the next served message. */
  noticePending: boolean
}

/** Users this bot has seen, in groups or DMs. Metadata only. */
export interface QQBotUser {
  selfId: string
  /** User openid (same across all groups and DMs of one bot). */
  id: string
  platform: string
  /** Last name seen; group events carry it, DM events do not. */
  name: string
  firstSeen: Date
  lastSeen: Date
  messageCount: number
  dmCount: number
  /** This user's DM is served even though they are not an op. */
  dmActive: boolean
}

/** Who has spoken in which group. Covers speakers only, not full membership. */
export interface QQBotMember {
  selfId: string
  channelId: string
  userId: string
  firstSeen: Date
  lastSeen: Date
  messageCount: number
}

/** Audit of group-setting migrations from OneBot. */
export interface QQBotMigration {
  id: number
  kind: string
  /** Old OneBot group number. */
  oldId: string
  /** New group openid. */
  newId: string
  selfId: string
  /** Koishi user id of the operator. */
  operator: number
  time: Date
  /** Field names copied from the old channel row. */
  fields: string[]
}

declare module 'koishi' {
  interface Tables {
    qqbot_message: QQBotMessage
    qqbot_channel: QQBotChannel
    qqbot_user: QQBotUser
    qqbot_member: QQBotMember
    qqbot_migration: QQBotMigration
  }
}

export function defineTables(ctx: Context) {
  ctx.model.extend(
    'qqbot_message',
    {
      selfId: 'string(64)',
      channelId: 'string(128)',
      messageId: 'string(255)',
      userId: 'string(64)',
      username: 'string(255)',
      isBot: 'boolean',
      isSelf: 'boolean',
      content: 'text',
      mentions: 'list',
      quoteId: 'string(255)',
      time: 'timestamp',
    },
    { primary: ['selfId', 'channelId', 'messageId'] }
  )
  ctx.model.extend(
    'qqbot_channel',
    {
      selfId: 'string(64)',
      id: 'string(128)',
      platform: 'string(32)',
      name: 'string(255)',
      memberNum: 'unsigned',
      role: 'string(32)',
      recvSetting: 'string(32)',
      allowProactive: 'boolean',
      recvRejected: 'boolean',
      addedBy: 'string(64)',
      firstSeen: 'timestamp',
      lastSeen: 'timestamp',
      messageCount: 'unsigned',
      removedAt: 'timestamp',
      infoUpdatedAt: 'timestamp',
      noticeSentAt: 'timestamp',
      noticePending: 'boolean',
    },
    { primary: ['selfId', 'id'] }
  )
  ctx.model.extend(
    'qqbot_user',
    {
      selfId: 'string(64)',
      id: 'string(64)',
      platform: 'string(32)',
      name: 'string(255)',
      firstSeen: 'timestamp',
      lastSeen: 'timestamp',
      messageCount: 'unsigned',
      dmCount: 'unsigned',
      dmActive: 'boolean',
    },
    { primary: ['selfId', 'id'] }
  )
  ctx.model.extend(
    'qqbot_member',
    {
      selfId: 'string(64)',
      channelId: 'string(128)',
      userId: 'string(64)',
      firstSeen: 'timestamp',
      lastSeen: 'timestamp',
      messageCount: 'unsigned',
    },
    { primary: ['selfId', 'channelId', 'userId'] }
  )
  ctx.model.extend(
    'qqbot_migration',
    {
      id: 'unsigned',
      kind: 'string(32)',
      oldId: 'string(64)',
      newId: 'string(128)',
      selfId: 'string(64)',
      operator: 'unsigned',
      time: 'timestamp',
      fields: 'list',
    },
    { autoInc: true }
  )
}
