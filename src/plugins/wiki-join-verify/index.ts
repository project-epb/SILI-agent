import { Context, Logger, Schema, Session, h } from 'koishi'

import { isGroupAdmin } from '@/modules/CommandPermissions'

import { markdownLink, markdownText } from '~/mediawiki/qq-reply'
import { useApi } from '~/mediawiki/utils'

import {
  type Bind,
  type Policy,
  type VerifySource,
  type WikiUser,
  bindOnApproval,
  decide,
  latestPerMember,
} from './verify'

declare module 'koishi' {
  interface Tables {
    wiki_join_code: WikiJoinCode
    wiki_join_binding: WikiJoinBinding
  }
}

/** A spent one-time code: the page hash it was saved as. */
export interface WikiJoinCode {
  hash: string
  wiki: string
  wikiUserId: number
  platform: string
  selfId: string
  userId: string
  time: Date
}

/** The wiki account an openid joins as. One per openid and wiki. */
export interface WikiJoinBinding {
  wiki: string
  platform: string
  selfId: string
  userId: string
  wikiUserId: number
  wikiUserName: string
  source: 'auto' | 'manual'
  time: Date
}

export interface ChannelPolicy {
  /** Group openid, as this bot sees it. */
  id: string
  /** Wiki groups admitted (any one); empty admits any bound account. */
  groups?: string[]
  /** A temporary membership counts only once held this many days. */
  tempMinDays?: number
}

export interface Site {
  /** Stable key stored with codes and bindings. */
  key: string
  /** Site name shown in messages. */
  label: string
  /** api.php URL. */
  api: string
  /** Page URL template, `$1` is the title. */
  articleUrl: string
  /** Verify page is `User:<name>/<verifyPage>`. */
  verifyPage: string
  channels: ChannelPolicy[]
}

export interface Config {
  sites: Site[]
}

/** Requests listed per message: QQ allows 5 keyboard rows. */
const LIST_LIMIT = 5
/** Short request id shown to admins: the openid's first characters. */
const SHORT_ID_LENGTH = 6

/** One pending request as returned by `join_request_list`. */
interface JoinRequest {
  join_request_id: string
  member_openid: string
  username: string
  apply_at: string
  verify_info?: {
    verify_message?: string
    review_qa_list?: { question: string; answer: string }[]
  }
}

export default class PluginWikiJoinVerify {
  static inject = ['database']
  static Config: Schema<Config> = Schema.object({
    sites: Schema.array(Schema.any()).default([]),
  })

  private logger: Logger
  /**
   * Applicants being reviewed, by `channel:openid`. Taken before any await, so
   * two presses at once (two admins, two devices) cannot both handle one
   * request; always released in `finally`, so it never outgrows the reviews
   * in flight.
   */
  private reviewing = new Set<string>()

  constructor(
    private ctx: Context,
    private config: Config
  ) {
    this.logger = ctx.logger('wiki-join-verify')
    ctx.model.extend(
      'wiki_join_code',
      {
        hash: 'string(64)',
        wiki: 'string(32)',
        wikiUserId: 'unsigned(8)',
        platform: 'string(32)',
        selfId: 'string(64)',
        userId: 'string(128)',
        time: 'timestamp',
      },
      { primary: 'hash' }
    )
    ctx.model.extend(
      'wiki_join_binding',
      {
        wiki: 'string(32)',
        platform: 'string(32)',
        selfId: 'string(64)',
        userId: 'string(128)',
        wikiUserId: 'unsigned(8)',
        wikiUserName: 'string(255)',
        source: 'string(16)',
        time: 'timestamp',
      },
      { primary: ['wiki', 'platform', 'selfId', 'userId'] }
    )

    ctx.on('guild-member-request', (session) => {
      const target = this.lookup(session.channelId)
      if (!target) return
      void this.onRequest(session, target).catch((error) =>
        this.logger.warn('join request', error)
      )
    })

    ctx
      .command('channel.join-request', '查看本群待处理的入群申请')
      .alias('入群申请')
      .action(async ({ session }) => {
        const target = this.lookup(session!.channelId)
        if (!target) return '本群没有开启入群验证。'
        return this.list(session!, target)
      })
    for (const [name, alias, approve] of [
      ['approve', '通过', true],
      ['reject', '拒绝', false],
    ] as const) {
      ctx
        .command(
          `channel.join-request.${name} <id:string> [reason:text]`,
          approve ? '同意入群申请' : '拒绝入群申请'
        )
        // Not `入群申请.通过`: Koishi resolves a dotted name segment by
        // segment, so `入群申请` becomes the parent and the alias is never hit.
        .alias(`${alias}入群申请`)
        .action(async ({ session }, id, reason) => {
          const target = this.lookup(session!.channelId)
          if (!target) return '本群没有开启入群验证。'
          if (!this.isReviewer(session!))
            return '只有群管理员可以审批入群申请。'
          if (!id) return '请提供申请编号，可以先发送「入群申请」查看。'
          const text = await this.review(session!, target, id, approve, {
            reason,
          })
          return h('markdown', h.text(text))
        })
    }
  }

  private lookup(channelId?: string) {
    if (!channelId) return
    for (const site of this.config.sites) {
      const channel = site.channels.find((c) => c.id === channelId)
      if (channel) return { site, policy: policyOf(site, channel) }
    }
  }

  private isReviewer(session: Session) {
    return isGroupAdmin(session)
  }

  /** Lookups for one request; codes and bindings are scoped to bot and wiki. */
  private sourceFor(session: Session, site: Site): VerifySource {
    const scope = {
      wiki: site.key,
      platform: session.platform,
      selfId: session.selfId,
    }
    return {
      user: async (id) => {
        const api = await useApi(site.api)
        const { data } = await api.get({
          action: 'query',
          list: 'users',
          ususerids: id,
          usprop: 'groups|groupmemberships|blockinfo',
        })
        const user = data?.query?.users?.[0]
        if (!user || user.missing || user.invalid) return
        return {
          id: user.userid,
          name: user.name,
          groups: user.groups ?? [],
          memberships: user.groupmemberships ?? [],
          blocked: !!user.blockid,
        } satisfies WikiUser
      },
      verifyPage: async (name) => {
        const api = await useApi(site.api)
        const { data } = await api.get({
          action: 'query',
          prop: 'revisions',
          rvprop: 'user|content',
          rvslots: 'main',
          titles: `User:${name}/${site.verifyPage}`,
        })
        const revision = data?.query?.pages?.[0]?.revisions?.[0]
        if (!revision) return
        return {
          content: revision.slots?.main?.content ?? '',
          editor: revision.user ?? '',
        }
      },
      groupAddedAt: async (name, group) => {
        const api = await useApi(site.api)
        const { data } = await api.get({
          action: 'query',
          list: 'logevents',
          letype: 'rights',
          letitle: `User:${name}`,
          leprop: 'timestamp|details',
          lelimit: 50,
        })
        // Newest first; a renewal keeps the group on both sides and is skipped.
        const granted = (data?.query?.logevents ?? []).find(
          (e: any) =>
            e.params?.newgroups?.includes(group) &&
            !e.params?.oldgroups?.includes(group)
        )
        return granted ? Date.parse(granted.timestamp) : undefined
      },
      codeSpentBy: async (hash) => {
        const [row] = await this.ctx.database.get('wiki_join_code', { hash })
        if (!row) return
        // An openid from another bot is a different person to this one.
        return row.selfId === session.selfId
          ? row.userId
          : `${row.selfId}:${row.userId}`
      },
      boundTo: async (openid) => {
        const [row] = await this.ctx.database.get('wiki_join_binding', {
          ...scope,
          userId: openid,
        })
        return row?.wikiUserId
      },
      boundOpenids: async (wikiUserId) =>
        (
          await this.ctx.database.get('wiki_join_binding', {
            ...scope,
            wikiUserId,
          })
        ).map((row) => row.userId),
    }
  }

  /**
   * Spends the code (atomically: the hash is the primary key) and records the
   * binding. Returns false when the code was spent meanwhile.
   */
  private async spend(
    session: Session,
    site: Site,
    openid: string,
    bind: Bind
  ) {
    if (!bind.hash) return true
    try {
      await this.ctx.database.create('wiki_join_code', {
        hash: bind.hash,
        wiki: site.key,
        wikiUserId: bind.wikiUserId,
        platform: session.platform,
        selfId: session.selfId,
        userId: openid,
        time: new Date(),
      })
      return true
    } catch (error) {
      this.logger.debug('spend code', error)
      return false
    }
  }

  private async saveBinding(
    session: Session,
    site: Site,
    openid: string,
    bind: Bind,
    source: WikiJoinBinding['source']
  ) {
    await this.ctx.database
      .upsert('wiki_join_binding', [
        {
          wiki: site.key,
          platform: session.platform,
          selfId: session.selfId,
          userId: openid,
          wikiUserId: bind.wikiUserId,
          wikiUserName: bind.wikiUserName,
          source,
          time: new Date(),
        },
      ])
      .catch((error) => this.logger.warn('save binding', error))
  }

  private async onRequest(
    session: Session,
    { site, policy }: { site: Site; policy: Policy }
  ) {
    const raw = (session.event as any)._data?.d ?? {}
    const request: JoinRequest = {
      join_request_id: raw.join_request_id ?? session.messageId!,
      member_openid: session.userId!,
      username: session.event.user?.name || raw.username || '',
      apply_at: raw.apply_at ?? '',
      verify_info: raw.verify_info,
    }
    const applicant = applicantLabel(request)
    const source = this.sourceFor(session, site)

    let lines: string[]
    try {
      let decision = await decide(
        answerOf(request),
        request.member_openid,
        source,
        policy
      )
      // A concurrent request spent the code first: decide again with it spent.
      if (
        decision.ok &&
        decision.bind &&
        !(await this.spend(session, site, request.member_openid, decision.bind))
      )
        decision = await decide(
          answerOf(request),
          request.member_openid,
          source,
          policy
        )

      if (!('reason' in decision)) {
        try {
          await this.handleRequest(session, request, true)
        } catch (error) {
          await this.notify(
            session,
            this.pending(
              site,
              request,
              `验证已通过，但自动同意失败：${errorText(error)}`,
              decision.user
            ).join('\n\n'),
            [request],
            { passive: false }
          )
          return
        }
        if (decision.bind)
          await this.saveBinding(
            session,
            site,
            request.member_openid,
            decision.bind,
            'auto'
          )
        lines = [
          `✅ 已自动同意入群：${applicant}`,
          `${site.label}账号：${this.userLink(site, decision.user.name)}`,
        ]
      } else {
        const { reason, user } = decision as {
          reason: string
          user?: { name: string }
        }
        lines = this.pending(site, request, reason, user)
        await this.notify(session, lines.join('\n\n'), [request], {
          passive: false,
        })
        return
      }
    } catch (error) {
      lines = this.pending(
        site,
        request,
        `查询${site.label}失败：${errorText(error)}`
      )
      await this.notify(session, lines.join('\n\n'), [request], {
        passive: false,
      })
      return
    }
    await this.notify(session, lines.join('\n\n'), [], { passive: false })
  }

  private pending(
    site: Site,
    request: JoinRequest,
    reason: string,
    user?: { name: string }
  ) {
    return [
      `⚠️ 入群申请待人工审核：${applicantLabel(request)}（编号 ${shortId(request)}）`,
      `原因：${markdownText(reason)}`,
      ...(user
        ? [
            markdownLink(
              `核对「${user.name}」的验证页`,
              this.pageUrl(site, `User:${user.name}/${site.verifyPage}`)
            ),
          ]
        : []),
      '按钮 30 分钟内有效，过期后发送「入群申请」重新列出。',
    ]
  }

  /** Pending requests of this group, re-verified, with fresh buttons. */
  private async list(
    session: Session,
    { site, policy }: { site: Site; policy: Policy }
  ) {
    const requests = await this.fetchRequests(session)
    if (!requests.length) return '本群没有待处理的入群申请。'
    const shown = requests.slice(0, LIST_LIMIT)
    const source = this.sourceFor(session, site)
    const blocks: string[] = []
    for (const request of shown) {
      let verdict: string
      try {
        const decision = await decide(
          answerOf(request),
          request.member_openid,
          source,
          policy
        )
        verdict = !('reason' in decision)
          ? `验证通过（${site.label}账号：${this.userLink(site, decision.user.name)}）`
          : `待审核：${markdownText((decision as { reason: string }).reason)}`
      } catch (error) {
        verdict = `查询${site.label}失败：${markdownText(errorText(error))}`
      }
      blocks.push(
        `**${applicantLabel(request)}**（编号 ${shortId(request)}）\n${verdict}`
      )
    }
    if (requests.length > shown.length)
      blocks.push(
        `还有 ${requests.length - shown.length} 条申请未列出，处理完以上申请后再查看。`
      )
    blocks.push('按钮仅群管理员可点，30 分钟内有效。')
    return keyboardMessage(blocks.join('\n\n'), shown)
  }

  /**
   * Approves or rejects one pending request picked by an openid prefix (the
   * short id). Returns the markdown reply.
   */
  private async review(
    session: Session,
    target: { site: Site; policy: Policy },
    key: string,
    approve: boolean,
    { reason }: { reason?: string } = {}
  ): Promise<string> {
    const gone = '没有找到这条申请，可能已被处理。'
    const matches = (await this.fetchRequests(session)).filter((r) =>
      r.member_openid.startsWith(key.toUpperCase())
    )
    if (!matches.length) return gone
    if (matches.length > 1) return '编号对应多条申请，请多写几位。'
    const openid = matches[0].member_openid
    const lock = `${session.channelId}:${openid}`
    if (this.reviewing.has(lock)) return '这条申请正在处理中。'
    this.reviewing.add(lock)
    try {
      // The list above may predate a review that just finished: confirm under
      // the lock that the request is still pending.
      const request = (await this.fetchRequests(session)).find(
        (r) => r.member_openid === openid
      )
      if (!request) return gone
      return await this.settle(session, target, request, approve, reason)
    } finally {
      this.reviewing.delete(lock)
    }
  }

  private async settle(
    session: Session,
    { site, policy }: { site: Site; policy: Policy },
    request: JoinRequest,
    approve: boolean,
    reason?: string
  ) {
    const applicant = applicantLabel(request)
    const operator = `<qqbot-at-user id="${session.userId}" />`

    if (!approve) {
      await this.handleRequest(session, request, false, reason)
      return `🚫 ${operator} 已拒绝入群：${applicant}`
    }

    const source = this.sourceFor(session, site)
    let bind = await bindOnApproval(
      answerOf(request),
      request.member_openid,
      source,
      policy
    )
    if (bind && !(await this.spend(session, site, request.member_openid, bind)))
      bind = await bindOnApproval(
        answerOf(request),
        request.member_openid,
        source,
        policy
      )
    await this.handleRequest(session, request, true)
    if (bind)
      await this.saveBinding(
        session,
        site,
        request.member_openid,
        bind,
        'manual'
      )
    return [
      `✅ ${operator} 已同意入群：${applicant}`,
      bind
        ? `${site.label}账号：${this.userLink(site, bind.wikiUserName)}`
        : `未绑定${site.label}账号`,
    ].join('\n\n')
  }

  private async fetchRequests(session: Session) {
    const internal = (session.bot as any).internal
    const all: JoinRequest[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
      const result = await internal.getJoinRequestList(session.channelId, {
        limit: 50,
        ...(cursor ? { cursor } : {}),
      })
      all.push(...(result?.list ?? []))
      if (!result?.next_cursor || !result.list?.length) break
      cursor = result.next_cursor
    }
    return latestPerMember(all)
  }

  /**
   * Calls the API directly: the adapter's handleGuildMemberRequest resolves
   * ids from an in-memory map that a restart empties.
   */
  private async handleRequest(
    session: Session,
    request: JoinRequest,
    approve: boolean,
    reason?: string
  ) {
    await (session.bot as any).internal.approveJoinRequest(
      session.channelId,
      request.member_openid,
      {
        op: approve ? 'approve' : 'decline',
        join_request_id: request.join_request_id,
        ...(!approve && reason ? { reject_reason: reason } : {}),
      }
    )
  }

  private userLink(site: Site, name: string) {
    return markdownLink(name, this.pageUrl(site, `User:${name}`))
  }

  private pageUrl(site: Site, title: string) {
    return site.articleUrl.replace('$1', encodeURI(title.replace(/ /g, '_')))
  }

  /**
   * Passive reply by event id first, proactive message otherwise. A join
   * request event cannot be replied to (40034027), so its notices pass
   * `passive: false` and go straight out proactively. The source session must
   * not expose messageId: qq-crack would send the join request id as msg_id
   * and fail.
   */
  private async notify(
    session: Session,
    markdown: string,
    requests: JoinRequest[] = [],
    { passive = true } = {}
  ) {
    const content = requests.length
      ? keyboardMessage(markdown, requests)
      : h('markdown', h.text(markdown))
    const source = Object.create(session, {
      messageId: { value: undefined },
    }) as Session
    if (passive) {
      try {
        const ids = await session.bot.sendMessage(
          session.channelId!,
          content,
          undefined,
          { session: source }
        )
        if (ids.length) return
      } catch (error) {
        this.logger.debug('passive notice failed, sending proactively', error)
      }
    }
    await session.bot.sendMessage(session.channelId!, content)
  }
}

function policyOf(site: Site, channel: ChannelPolicy): Policy {
  return {
    label: site.label,
    groups: channel.groups ?? [],
    tempMinDays: channel.tempMinDays,
  }
}

/**
 * The applicant's answer text. Not the adapter's session.content: it keeps an
 * empty `verify_message` and drops the Q&A list QQ sends alongside it.
 */
function answerOf(request: JoinRequest) {
  const info = request.verify_info
  return [
    info?.verify_message ?? '',
    ...(info?.review_qa_list ?? []).map((qa) => qa.answer),
  ].join('\n')
}

function applicantLabel(request: JoinRequest) {
  return markdownText(request.username || '（未知）')
}

function shortId(request: JoinRequest) {
  return request.member_openid.slice(0, SHORT_ID_LENGTH)
}

/**
 * Markdown with an approve/reject button row per request. The buttons are
 * command buttons: a press sends `@bot /通过入群申请 <id>` as the presser, so
 * the review runs through the command and its admin check, using the role QQ
 * attaches to that message. Do not turn them back into callback buttons: a
 * callback press carries no role, and the admins-only `permission` is not
 * enforced on every client.
 */
function keyboardMessage(markdown: string, requests: JoinRequest[]) {
  const button = (request: JoinRequest, approve: boolean) => {
    const label = approve ? `通过 ${request.username}`.slice(0, 20) : '拒绝'
    return {
      id: `${approve ? 'a' : 'r'}${shortId(request)}`,
      group_id: shortId(request),
      // visited_label shows on the pressing device the moment it is pressed,
      // whatever came of it, so it must not claim an outcome: keep the label.
      // The reply in the group is the result.
      render_data: {
        label,
        visited_label: label,
        style: approve ? 4 : 0,
      },
      action: {
        type: 2,
        permission: { type: 1 },
        data: `/${approve ? '通过' : '拒绝'}入群申请 ${shortId(request)}`,
        // Clients without `enter` support insert the command for a manual send.
        enter: true,
        unsupport_tips: '请升级 QQ 后操作，或发送「入群申请」',
        ...(approve
          ? {}
          : {
              modal: {
                content: `确定拒绝 ${request.username} 的入群申请？`.slice(
                  0,
                  40
                ),
                confirm_text: '拒绝',
                cancel_text: '取消',
              },
            }),
      },
    }
  }
  return h('qq:rawmarkdown', {
    content: markdown,
    keyboard: {
      content: {
        rows: requests.map((r) => ({
          buttons: [button(r, true), button(r, false)],
        })),
      },
    },
  })
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
