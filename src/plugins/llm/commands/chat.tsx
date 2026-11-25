import { Context, Session, Time, h } from 'koishi'

import crypto from 'node:crypto'

import { isGroupAdmin } from '@/modules/CommandPermissions'
import { cancellableInterval } from '@/utils/cancellableDefferred'
import { getUserRoles } from '@/utils/formatSession'

import BasePlugin from '~/_boilerplate'

import { runAgentLoop } from '../agent-loop'
import type { ChatMessage } from '../providers/_base'
import type { ActiveChatEntry, SteerItem } from '../services/active-chats'
import {
  type ConversationScope,
  resolveConversationScope,
} from '../services/conversation-scope'
import { parseStopKeyword } from '../utils/stop-keyword'
import type { TurnStatus } from '../services/history-filter'
import { createProgressNudge } from '../utils/progress-nudge'
import { describeChatError } from '../utils/chat-error'
import { noteImageIds, rewriteInboundImages, turnImages } from '../utils/inbound-images'
import { attachedImages } from '../services/image-store'
import { addTurnSpeaker } from '../utils/turn-speakers'
import { buildMemorySnapshot } from '../services/memory-snapshot'
import { ToolRegistry, getMemoryToolState, snapshotTiers } from '../tools'
import { sanitizeAgentOutput } from '../utils/output-filter'
import { PROTOCOL_ELEMENT_TYPES, PROTOCOL_TAGS } from '../utils/protocol'
import {
  buildQuotedMessageBlock,
  extractQuoteMeta,
  mergeRecordedQuote,
} from '../utils/quoted-message'
import { isAgentMessageStart, splitContent } from '../utils/stream-splitter'
import { clampThinkingBudget, resolveThinkingLevel } from '../utils/thinking'

/** Ops may stop anyone's turn. */
const STOP_ANY_TURN_AUTHORITY = 4

/**
 * In a shared group only whoever started the turn, a group admin or an op
 * may stop it, or any member could cut off someone else's task.
 */
function canStopTurn(
  session: Session,
  scope: ConversationScope,
  running: ActiveChatEntry
): boolean {
  if (!scope.shared) return true
  if (running.starterUserId === session.userId) return true
  if (((session.user as any)?.authority ?? 0) >= STOP_ANY_TURN_AUTHORITY)
    return true
  return isGroupAdmin(session)
}

/**
 * Steered messages as appended to a tool result: a notice that they
 * arrived mid-turn, then each message's own envelope. '' when none.
 */
const PROGRESS_NUDGE = [
  PROTOCOL_TAGS.STEER_NOTICE.open,
  "The user hasn't heard from you in a while — say in a few words what you're doing, then continue.",
  PROTOCOL_TAGS.STEER_NOTICE.close,
].join('\n')

function wrapSteer(items: SteerItem[]): string {
  if (!items.length) return ''
  // Prompt-less items are system notifications (e.g. <task_notification>):
  // they describe themselves, and the "reply to them" notice must not cover
  // them, or the model answers every finished job as if a user had spoken.
  const hasMessages = items.some((item) => item.prompt)
  return [
    hasMessages
      ? [
          PROTOCOL_TAGS.STEER_NOTICE.open,
          'The user sent new messages while you were working. This is how messages sent mid-turn are surfaced — within the running turn, alongside the next tool result, rather than as a separate conversation turn. Reply to them briefly first, then continue your current work.',
          PROTOCOL_TAGS.STEER_NOTICE.close,
        ].join('\n')
      : '',
    ...items.map((item) => item.envelope),
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Subplugin: the `;chat` command and its supporting flow.
 *
 * Loaded by PluginLLM via `ctx.plugin(ChatCommand)`. Stateless on its own —
 * everything threads through `ctx.llm` (parent plugin instance).
 *
 * Encapsulates the heaviest piece of the LLM plugin: stream lifecycle,
 * interrupt handling, agent loop integration, image-ref restoration, and
 * persistence of every message (user / assistant / tool).
 */
export default class ChatCommand extends BasePlugin {
  static inject = ['llm', 'database']

  /**
   * Quick-trigger keywords for web-search mode without `-s`. Heuristic only;
   * `-s true` overrides this in either direction.
   */
  private readonly ENABLE_SEARCH_KEYWORDS = [
    '搜索',
    '查找',
    '查一下',
    '找一下',
    '搜一下',
    '帮我找',
    '帮我搜',
    '帮我查',
    '最近',
    '最新',
    '今天',
    '昨天',
    '前天',
    '前几天',
    '几天前',
    '这周',
    '本周',
    '这个月',
    '本月',
    '今年',
    '新闻',
    '资讯',
    '动态',
    '发生了什么',
    '发生了啥',
  ]

  constructor(ctx: Context) {
    super(ctx, {}, 'llm-chat')
    this.#registerChat(ctx)
  }

  /**
   * Messages steered into a turn after its last tool iteration never
   * reached the model. Run them as the next turn: the newest one as the
   * trigger (it gets the passive replies), the rest as its backlog.
   */
  #runSteerLeftovers(key: string | number, entry: ActiveChatEntry) {
    const leftovers = entry.inbox.splice(0)
    // A stopped turn starts nothing on its own: what was steered in waits
    // for the next message.
    if (entry.abort.signal.reason === 'user-stop') {
      if (leftovers.length) this.ctx.llm.activeChats.putBacklog(key, leftovers)
      return
    }
    const trigger = leftovers.pop()
    if (!trigger) return
    // A message without a prompt (a task notification) has no envelope to
    // rebuild: it rides in the backlog and the turn runs without a prompt.
    if (!trigger.prompt) leftovers.push(trigger)
    if (leftovers.length) this.ctx.llm.activeChats.putBacklog(key, leftovers)
    trigger.session
      .execute({ name: 'chat', args: [trigger.prompt] })
      .catch((e) =>
        this.ctx.llm.logger.warn('[chat] steer leftover run failed:', e)
      )
  }

  /** Null when the conversation has no reply yet or history is unavailable. */
  async #countSinceLastReply(
    session: Session,
    conversationId: string | undefined
  ): Promise<number | null> {
    const history = this.ctx.channelMessageHistory
    if (!history || !conversationId) return null
    const [last] = await this.ctx.database.get(
      'openai_chat',
      { conversation_id: conversationId, role: 'assistant' },
      { fields: ['time'], sort: { time: 'desc' }, limit: 1 }
    )
    if (!last?.time) return null
    return history.countSince(session, new Date(last.time))
  }

  #shouldEnableSearch(content: string): boolean {
    return this.ENABLE_SEARCH_KEYWORDS.some((k) => content.includes(k))
  }

  #registerChat(ctx: Context) {
    ctx
      .command('llm/chat <content:text>', "I'm talking!", {
        minInterval: 1 * Time.minute,
        maxUsage: 10,
        bypassAuthority: 2,
      })
      .shortcut(/(.+)[\?？][\!！]$/, {
        args: ['$1'],
        prefix: true,
        options: { think: 'high' },
      })
      .shortcut(/(.+)[\?？]$/, { args: ['$1'], prefix: true })
      .option('no-prompt', '-P Disable system prompts', {
        type: 'boolean',
        hidden: true,
      })
      .option('prompt', '-p <prompt:string>', { hidden: true, authority: 2 })
      .option('model', '-m <model:string>', { hidden: true, authority: 2 })
      .option(
        'think',
        '-t <level:string> Reasoning level (low|medium|high|xhigh|max|no)',
        { hidden: true, fallback: 'low' }
      )
      .option('search', '-s Enable web search', {
        type: 'boolean',
        hidden: true,
        fallback: false,
      })
      .option('debug', '-d', { type: 'boolean', hidden: true, authority: 2 })
      .option('provider', '<provider:string> AI service to use', {
        hidden: true,
        authority: 2,
      })
      .userFields(['id', 'name', 'openai_last_conversation_id', 'authority'])
      .channelFields(['openai_last_conversation_id'])
      .check(({ session }, content) => {
        // No prompt is a turn only when something waits in the backlog (a
        // task notification, see #runSteerLeftovers).
        if (!content?.trim()) {
          const key = resolveConversationScope(session!).key
          if (!ctx.llm.activeChats.hasBacklog(key)) return ''
        }
      })
      .check(({ options }) => {
        if (options.model) {
          const llm = ctx.llm
          const maybeRealModel = llm.MODEL_ALIASES[options.model]
          if (maybeRealModel) options.model = maybeRealModel
          // provider#model 语法糖（e.g. openrouter#claude-opus-4.6）
          const hashIndex = options.model.indexOf('#')
          if (hashIndex > 0) {
            options.provider = options.model.slice(0, hashIndex)
            options.model = options.model.slice(hashIndex + 1)
          }
        }
      })
      .action(async ({ session, options }, userPrompt) => {
        const llm = ctx.llm
        llm.logger.info('[chat] input', options, userPrompt)
        // The model reads stickers and QQ faces by name, not as image urls.
        const stickerPool = llm.ctx.get('stickerPool')
        if (stickerPool && userPrompt)
          userPrompt = stickerPool.rewriteInbound(userPrompt)
        const fetchImage = (url: string) => llm.images.fetch(url)
        if (userPrompt)
          userPrompt = await rewriteInboundImages(userPrompt, fetchImage, llm.logger)

        const startTime = Date.now()
        const scope = resolveConversationScope(session)
        const conversation_owner = scope.owner
        // 本 chat invocation 在 conversation 内的 turn 编号；所有 row 共享。
        // 配合 intraSeq（user=0, 后续 ++）形成 history 的复合排序键。
        let turnNumber = -1
        let intraSeq = 0
        const nextSeq = () => ++intraSeq

        // A message reaching a running turn is steered into it further down.
        // Only a stop word (IM has no stop button) aborts the turn; what
        // follows the word then runs as this turn's prompt.
        let interruptScenario: 'fresh' | 'pre-stream' | 'mid-stream' = 'fresh'
        let interruptedOldPrompt = ''
        let inheritedConversationId: string | null = null
        const running = llm.activeChats.get(scope.key)
        const stopRest = running ? parseStopKeyword(userPrompt ?? '') : null
        const existingActive =
          running && stopRest !== null && canStopTurn(session, scope, running)
            ? running
            : undefined
        if (existingActive) {
          if (!stopRest) {
            llm.logger.info('[chat] stopped by keyword: id=%s', existingActive.conversationId)
            existingActive.abort.abort('user-stop')
            await existingActive.completion.catch(() => {})
            session.setReaction?.('🫡').catch(() => {})
            return
          }
          userPrompt = stopRest
          interruptScenario =
            existingActive.sendFromIndex.value === 0
              ? 'pre-stream'
              : 'mid-stream'
          interruptedOldPrompt = existingActive.pendingUserPrompt
          inheritedConversationId = existingActive.conversationId
          llm.logger.info(
            '[chat] interrupting prior session: scenario=%s id=%s',
            interruptScenario,
            inheritedConversationId
          )
          existingActive.abort.abort('user-stop')
          // 等老 session 真的 unwind（finally 解锁），避免和它的入库竞态
          await existingActive.completion.catch(() => {})
          // Nothing shown, but tools ran: the old turn stays in history with
          // its prompt, and the history note says it was interrupted.
          if (interruptScenario === 'pre-stream' && existingActive.wroteRecords)
            interruptScenario = 'fresh'
        }

        if (options['no-prompt']) options.prompt = ''

        const providerConfig = options.provider
          ? llm.config.providers.find((p) => p.name === options.provider)
          : llm.config.providers[0]

        const provider = options.provider
          ? llm.useProvider(options.provider)
          : llm.defaultProvider

        const model =
          options.model ||
          providerConfig?.model ||
          llm.config.model ||
          'gpt-4o-mini'

        const maxTokens =
          providerConfig?.maxTokens ?? llm.config.maxTokens ?? 1024

        const { enableThinking: rawEnableThinking, thinkingBudget: rawBudget } =
          resolveThinkingLevel(options.think)
        const safeBudget = rawEnableThinking
          ? clampThinkingBudget(rawBudget, maxTokens)
          : 0
        const enableThinking = rawEnableThinking && safeBudget > 0
        const thinkingBudget = safeBudget

        // History load + chatMessages assembly are deferred until AFTER
        // session rotation (which may reassign conversation_id) and the
        // summary-compactor call below — both can change what
        // `chatHistory.getById` returns, so loading earlier would race
        // and serve a stale prompt to the agent loop.

        const TZ = 'Asia/Shanghai'
        // Three name sources surfaced to the agent (priority for "how to
        // call this user": callme > group_nickname > platform.user.name):
        //   - koishi.callme: user-set preference (via the ;callme command)
        //   - platform.user.name: platform-native username
        //   - platform.user.group_nickname: QQ group card (group only;
        //     undefined elsewhere → JSON.stringify drops the key)
        // Group only: how much of the group chat went by since SILI's last
        // LLM reply. A bare number; nothing nudges her to go read it. The
        // anchor is the conversation's last assistant row, not the bot's
        // last message: command replies (dice, wiki links) are the bot
        // speaking too, but the conversation never saw what came before them.
        const messagesSinceLastReply = scope.shared
          ? await this.#countSinceLastReply(
              session,
              scope.conversationId
            ).catch(() => null)
          : null
        const chatInfo = {
          message_id: session.messageId || undefined,
          koishi: {
            uid: session.user.id,
            callme: session.user.name,
            authority: session.user.authority,
          },
          platform: {
            kind:
              session.platform === 'onebot' ? 'onebot(qq)' : session.platform,
            user: {
              id: session.event.user?.id,
              name: session.event.user?.name,
              group_nickname: session.event.member?.nick,
              channel_roles:
                getUserRoles(session)
                  .map((r) => r.id)
                  .join(',') || undefined,
            },
            channel: {
              id: session.event.channel?.id,
              name:
                session.event._data?.group_name || session.event.channel?.name,
              type: session.event.channel?.type,
              messages_since_your_last_reply:
                messagesSinceLastReply ?? undefined,
            },
          },
          time: new Date().toLocaleString('sv', { timeZone: TZ }) + ` (${TZ})`,
        }
        // 系统注入元数据 + 用户原话用 XML tag 隔离，防止"复述我的消息"类
        // 注入把 turn_context 块带出来。系统侧的 routing 协议在 system
        // prompt 的「消息协议」段教育模型如何识别。
        //
        // 打断场景：
        // - pre-stream（老 session 还没流出任何 token）：把上一句和这一句
        //   作为单条 user_message 拼接，模型视角等价于"用户连发了两段"
        // - mid-stream（用户已看到部分回复）：在 turn_context 后注入临时 block
        //   <interrupt_notice> 教模型当前的对话状态 + 给它"说 <silent/> 选
        //   择沉默"的能力。这个 block 不入 history，下一轮自动消失，避免
        //   AI 滥用沉默
        const userMessageBody =
          interruptScenario === 'pre-stream' && interruptedOldPrompt
            ? `${interruptedOldPrompt}\n\n${userPrompt}`
            : userPrompt
        const interruptNoticeBlock =
          interruptScenario === 'mid-stream'
            ? [
                PROTOCOL_TAGS.INTERRUPT_NOTICE.open,
                '用户叫停了上一轮回复，接着发了这条消息。',
                '按这条消息做，不要重复或继续上一轮未说完的内容。',
                PROTOCOL_TAGS.INTERRUPT_NOTICE.close,
              ].join('\n')
            : ''
        // turn_context envelope: just the JSON, no per-turn explainers.
        // The static field-meaning + "don't echo" rules live in the system
        // prompt's `## 消息协议` section so they're cached forever and
        // don't repeat in every prompt.
        //
        // The envelope is split into two pieces:
        //   - persistableEnvelope: turn_context + user_message, byte-
        //     stable enough to store in db so REPLAYED history matches
        //     what we SENT last turn → previous-user position keeps the
        //     provider's prefix cache instead of always being a miss.
        //   - userMessageEnvelope: persistable + (optional) interrupt
        //     notice. Interrupt notices are turn-specific instructions
        //     (offer the <silent/> bailout for "shut up"-style asks),
        //     so they MUST NOT leak into persisted history — replaying
        //     them would offer silent-mode in irrelevant future turns.
        const chatInfoBlock = [
          PROTOCOL_TAGS.TURN_CONTEXT.open,
          JSON.stringify(chatInfo),
          PROTOCOL_TAGS.TURN_CONTEXT.close,
        ].join('\n')
        // Quote-reply context: without it the agent sees the user's words with no
        // idea which message they hang off. Part of the persistable envelope —
        // unlike an interrupt notice this is fact, not a one-shot instruction, so
        // replaying it next turn keeps multi-turn threads coherent.
        // The block carries the quoted message's id, which read_channel_history
        // accepts as `before_message_id` — free to produce here (it is already on
        // session.quote), and the id → cursor lookup only happens if the agent
        // actually decides it needs the surrounding history.
        let quoteMeta = extractQuoteMeta(session)
        if (quoteMeta?.messageId) {
          const recorded = await llm.ctx.channelMessageHistory
            ?.find(session, quoteMeta.messageId)
            .catch(() => undefined)
          if (recorded) quoteMeta = mergeRecordedQuote(quoteMeta, recorded, TZ)
        }
        if (quoteMeta && stickerPool) {
          quoteMeta = {
            ...quoteMeta,
            content: stickerPool.rewriteInbound(quoteMeta.content),
          }
        }
        if (quoteMeta)
          quoteMeta = {
            ...quoteMeta,
            content: await rewriteInboundImages(quoteMeta.content, fetchImage, llm.logger),
          }
        const quotedMessageBlock = quoteMeta
          ? buildQuotedMessageBlock(
              quoteMeta,
              llm.config.quotedMessageMaxLength ?? 1000
            )
          : ''
        const userMessageBlock = userMessageBody
          ? [
              PROTOCOL_TAGS.USER_MESSAGE.open,
              userMessageBody,
              PROTOCOL_TAGS.USER_MESSAGE.close,
            ].join('\n')
          : ''
        // Where this message's images and files landed on the Linux machine.
        const attachmentsBlock = userMessageBody
          ? await llm.ctx
              .get('linux')
              ?.saveAttachments(session)
              .catch((e: unknown) => {
                llm.logger.warn('[chat] saving attachments failed:', e)
                return ''
              })
          : ''
        // The first few images of this message go with it as pixels; which
        // ones is fixed here and stored with the row, so replay matches.
        const ownImages = attachedImages(`${quotedMessageBlock}\n${userMessageBlock}`)
        let envelopeImages = ownImages.ids
        // Base envelope shapes — the optional memory snapshot prefix is
        // computed AFTER history load (we only seed memory on the first
        // turn of a fresh conversation, and post-compaction sessions
        // already carry the snapshot inside their summary user row).
        let persistableEnvelopeBase = [
          userMessageBody ? chatInfoBlock : '',
          quotedMessageBlock,
          attachmentsBlock,
          userMessageBlock,
          ownImages.note,
        ]
          .filter(Boolean)
          .join('\n')
        // The quote block belongs in the interrupt path too — being interrupted
        // doesn't make the user's quote any less relevant.
        let userMessageEnvelopeBase = interruptNoticeBlock
          ? [
              chatInfoBlock,
              interruptNoticeBlock,
              quotedMessageBlock,
              attachmentsBlock,
              userMessageBlock,
              ownImages.note,
            ]
              .filter(Boolean)
              .join('\n')
          : persistableEnvelopeBase

        // Per-turn tool state, handed to the agent loop. Memory writes are
        // refused once the turn carries someone else's message.
        const turnState: Record<string, unknown> = {}
        addTurnSpeaker(turnState, session)
        // Prompt-less items are task notifications: no one spoke them.
        const noteSpeakers = (items: SteerItem[]) => {
          for (const item of items) if (item.prompt) addTurnSpeaker(turnState, item.session)
        }
        const fromOthers = (items: SteerItem[]) =>
          items.some((item) => item.prompt && item.session.userId !== session.userId)
        // Re-read: the awaits above let a turn start or end meanwhile.
        const runningNow = llm.activeChats.get(scope.key)
        if (runningNow) {
          runningNow.inbox.push({
            session,
            prompt: userPrompt ?? '',
            envelope: persistableEnvelopeBase,
            images: envelopeImages,
          })
          llm.logger.info('[chat] steered into the running turn of %s', scope.key)
          return
        }
        // Messages steered into the previous turn too late for it to see.
        const backlog = llm.activeChats.takeBacklog(scope.key)
        if (backlog.length) {
          noteSpeakers(backlog)
          if (fromOthers(backlog))
            getMemoryToolState(turnState).othersSpoke = true
          const earlier = backlog.map((item) => item.envelope).join('\n\n')
          const prepend = (base: string) => [earlier, base].filter(Boolean).join('\n\n')
          persistableEnvelopeBase = prepend(persistableEnvelopeBase)
          userMessageEnvelopeBase = prepend(userMessageEnvelopeBase)
          envelopeImages = [...backlog.flatMap((item) => item.images ?? []), ...envelopeImages]
        }

        // 解析 conversation_id：
        // - 打断场景：直接用老 session 挂的 id（不读 user 字段，避免 race
        //   condition——老 action 还没 persist 时新 action 拉到的是旧值）
        // - 普通场景：读 user.openai_last_conversation_id；为空则生成新 UUID
        //
        // No await between the steer check above and register() below:
        // two group messages racing in must not both start a turn.
        let conversation_id =
          inheritedConversationId || scope.conversationId || crypto.randomUUID()

        const abortController = new AbortController()
        const sendFromIndexRef = { value: 0 }
        let resolveCompletion: () => void = () => {}
        const completion = new Promise<void>((res) => {
          resolveCompletion = res
        })
        const activeEntry: ActiveChatEntry = {
          abort: abortController,
          sendFromIndex: sendFromIndexRef,
          pendingUserPrompt: userPrompt ?? '',
          completion,
          conversationId: conversation_id,
          inbox: [],
          wroteRecords: false,
          starterUserId: session.userId ?? '',
        }
        llm.activeChats.register(scope.key, activeEntry)
        if (scope.conversationId !== conversation_id) {
          await scope.setConversationId(conversation_id)
        }

        // chatMessages is populated after systemPromptText is resolved
        // (post-rotation) and after the summary compactor runs — see the
        // block right after `systemPromptText = ...` below.
        const chatMessages: ChatMessage[] = []

        const enableSearch =
          !!options.search || this.#shouldEnableSearch(userPrompt)

        // 用于流式逐字输出的累积缓冲，emoji reaction 检测它非空后停止
        let sendBuffer = ''
        // sendFromIndex 同时挂在 activeChats entry 上，让二次进入能读到
        const sendFromIndex = sendFromIndexRef

        // 没开调试时，每思考 10 秒发送一个状态指示器
        const emojiCodes = ['181', '285', '267', '312', '284', '37']
        let currentEmojiIndex = -1
        const stopEmojiReaction = cancellableInterval(
          () => {
            if (sendBuffer.length > 0) {
              stopEmojiReaction()
            } else {
              currentEmojiIndex = (currentEmojiIndex + 1) % emojiCodes.length
              session
                ?.setReaction?.(emojiCodes[currentEmojiIndex])
                .catch(() => {})
            }
          },
          10 * 1000,
          60 * 1000
        )

        // 解析记忆 key（platform/userId）
        const { platform, userId } = llm.resolveMemoryKey(session)

        // 构造 system prompt。
        // - System prompt 不再绑定到 session row，而是按 (basePrompt, catalog)
        //   在进程内派生 + 缓存：跨用户/跨 session 共享同一字符串，prompt
        //   prefix cache 命中率最大化。
        // - prompt.md 改了 → 重启进程；新插件注册命令 → catalog 懒重建 →
        //   缓存自然失效。
        // - --prompt 覆盖路径：旁路缓存，每次合成。
        // - Memory 不再写进 prompt：模型按需调 read_user_memory tool 获取。
        const commandCatalog = llm.catalog.getOrRefresh()
        let systemPromptText: string
        if (typeof options.prompt === 'string') {
          systemPromptText = llm.systemPrompt.buildWithBase(
            options.prompt,
            commandCatalog
          )
        } else {
          // A group conversation never rotates on idle; it is kept in check
          // by compaction instead.
          const idleTtlMs = scope.shared
            ? Number.POSITIVE_INFINITY
            : (llm.config.sessionIdleTimeoutMs ?? 3 * 24 * 60 * 60 * 1000)
          const { session: existingSessionRow, expired } =
            await llm.sessions.getActive(conversation_id, idleTtlMs)
          if (existingSessionRow) {
            llm.sessions
              .touch(existingSessionRow.id)
              .catch((e) => llm.logger.warn('[session] touch failed:', e))
          } else {
            if (expired) {
              // rotate: 老 session row 留库作为历史，新 conversation_id 起新对话
              const newId = crypto.randomUUID()
              llm.logger.info(
                '[session] rotating idle session %s -> %s',
                conversation_id,
                newId
              )
              conversation_id = newId
              await scope.setConversationId(newId)
              // activeChats entry 上挂的 id 也同步更新，避免后续打断
              // 进来读到老 id 又分歧
              const active = llm.activeChats.get(scope.key)
              if (active) active.conversationId = newId
            }
            await llm.sessions.create({
              conversationId: conversation_id,
              conversationOwner: conversation_owner,
              platform,
              userId: scope.shared ? scope.sessionUserId : userId,
              userFirstMsg: userPrompt ?? '',
            })
          }
          systemPromptText = llm.systemPrompt.get(commandCatalog)
        }

        // Summary compaction — runs synchronously before history load.
        // When user-turn count for this conversation crosses the
        // configured threshold, the compactor runs one summary call
        // (forked: same provider + system prompt + history so it
        // benefits from prompt cache state), mints a NEW conversation_id
        // seeded with the (please-summarize, summary-text) pair, links
        // it back via session.prev_session_id, and returns the new id.
        // Caller adopts it so the rest of this chat invocation runs on
        // the compacted session.
        //
        // Failures are logged and swallowed — chat proceeds on the
        // un-compacted conversation, threshold check re-runs next turn.
        try {
          const compactRes = await llm.summary.compactIfNeeded({
            conversation_id,
            conversation_owner,
            memory: llm.memorySources(
              platform,
              llm.memoryOwners(session),
              snapshotTiers(session.isDirect, scope.shared)
            ),
            systemPrompt: systemPromptText,
            provider,
            model,
            platform,
            userId: scope.shared ? scope.sessionUserId : userId,
            features: { signal: abortController.signal },
          })
          if (compactRes.ran && compactRes.newConversationId) {
            llm.logger.success(
              '[chat] summary compaction fired: %s → %s (%d-char summary)',
              compactRes.prevConversationId,
              compactRes.newConversationId,
              compactRes.summaryLength
            )
            conversation_id = compactRes.newConversationId
            await scope.setConversationId(compactRes.newConversationId)
            // ActiveChatRegistry entry is keyed by owner but caches the
            // conversation id; sync so a later interrupt sees the new id.
            const active = llm.activeChats.get(scope.key)
            if (active) active.conversationId = compactRes.newConversationId
          }
        } catch (e) {
          llm.logger.warn('[chat] summary compaction errored (non-fatal):', e)
        }

        // Everything since the last compaction: compaction keeps it in
        // check, and a stable prefix keeps the prompt cache warm.
        const { messages: histories, pendingNote } =
          await llm.chatHistory.getHistory(conversation_id)
        llm.logger.info('[chat] user data', {
          conversation_owner,
          conversation_id,
          historiesLength: histories.length,
        })

        // First-turn memory bootstrap: if this is the conversation's first
        // exchange (no prior history), prepend the user's long-term
        // memory as a <long_term_memory> snapshot to the user envelope.
        // Compaction-spawned conversations already carry the snapshot
        // inside their summary user row, so `histories.length === 0`
        // cleanly discriminates "fresh / reset / idle-rotated" from
        // "post-compaction" — only the former needs seeding here.
        // A group's shared conversation carries only the group's memory;
        // members' own records are read on demand. Private records never
        // appear outside a DM.
        const memoryPrefix =
          histories.length === 0
            ? await buildMemorySnapshot(
                llm.memorySources(
                  platform,
                  llm.memoryOwners(session),
                  snapshotTiers(session.isDirect, scope.shared)
                ),
                llm.logger
              )
            : ''
        const persistableEnvelope = memoryPrefix
          ? `${memoryPrefix}\n\n${persistableEnvelopeBase}`
          : persistableEnvelopeBase
        const userMessageEnvelope = memoryPrefix
          ? `${memoryPrefix}\n\n${userMessageEnvelopeBase}`
          : userMessageEnvelopeBase

        // When the previous turn did not finish, the note goes in front of
        // what is sent but not what is stored: replay derives it again from
        // that turn's status (history-filter), so the bytes match.
        chatMessages.push(
          { role: 'system', content: systemPromptText },
          ...histories,
          {
            role: 'user',
            content: pendingNote
              ? `${pendingNote}\n\n${userMessageEnvelope}`
              : userMessageEnvelope,
            ...(envelopeImages.length && { images: envelopeImages }),
          }
        )
        for (const m of chatMessages) {
          noteImageIds(turnState, m.content)
          if ('images' in m) for (const id of m.images ?? []) turnImages(turnState).seen.add(id)
        }

        // 分配本 chat invocation 的 turn_number。在 session rotation 之后、
        // 任何 record 落库之前 allocate；ActiveChatRegistry 已经按 owner
        // 串行 chat，所以 in-memory counter 严格单调，被打断的老 chat 与
        // 后续新 chat 拿到的 turn_number 不会撞。
        turnNumber = await llm.turns.allocate(conversation_id)

        // The user row is stored now, as `running`, and its status set when
        // the turn ends. Stored at the end instead, a turn that dies midway
        // (provider error, crash, restart) vanishes from history along with
        // the tools it already ran. Persist the wrapped envelope (sans
        // interrupt notice and note) so the bytes in db match what was sent
        // at this position and the provider's prefix cache survives replay.
        // Behind a config flag while we measure the cache-hit-rate impact.
        const persistedUserContent =
          llm.config.persistWrappedUserMessage !== false
            ? persistableEnvelope
            : userPrompt
        await llm.ctx.database.create('openai_chat', {
          conversation_owner,
          conversation_id,
          role: 'user',
          content: persistedUserContent,
          reasoning_content: '',
          time: startTime,
          turn_number: turnNumber,
          intra_turn_seq: 0,
          turn_status: 'running',
          ...(envelopeImages.length && { images: envelopeImages }),
        } as any)
        const thisTurn = {
          conversation_id,
          turn_number: turnNumber,
        }
        const endTurn = (turn_status: TurnStatus, turn_error?: string) =>
          llm.ctx.database
            .set(
              'openai_chat',
              { ...thisTurn, intra_turn_seq: 0, role: 'user' },
              { turn_status, ...(turn_error && { turn_error }) }
            )
            .catch((e) =>
              llm.logger.warn('[chat] turn status update failed:', e)
            )
        const dropTurn = () =>
          llm.ctx.database
            .remove('openai_chat', thisTurn)
            .catch((e) => llm.logger.warn('[chat] turn removal failed:', e))

        // 逐字流给用户的 helper
        const progressNudge = createProgressNudge({
          afterMs: llm.config.progressNudgeAfterMs ?? 0,
          afterToolCalls: llm.config.progressNudgeAfterToolCalls ?? 0,
        })
        const flushVisibleText = async (force: boolean) => {
          while (sendFromIndex.value < sendBuffer.length) {
            const from = sendFromIndex.value
            const next = splitContent(sendBuffer, from, {
              maxChunkLen: 500,
              force,
            })
            if (next.nextIndex === from) return
            if (!next.text) {
              sendFromIndex.value = next.nextIndex
              continue
            }
            stopEmojiReaction()
            progressNudge.seen()
            const safeText = await llm.imageRefs.resolveRefsToDataUris(
              sanitizeAgentOutput(
                next.text,
                isAgentMessageStart(sendBuffer, from)
              )
            )
            const elements = h.parse(safeText)
            const quoteType = PROTOCOL_ELEMENT_TYPES.REPLY_QUOTE
            const quoteId = elements.find((e) => e.type === quoteType)?.attrs.id
            const quoted =
              typeof quoteId === 'string' && quoteId
                ? await llm.ctx.channelMessageHistory
                    ?.find(session, quoteId)
                    .catch(() => undefined)
                : undefined
            let quote = quoted
              ? h(quoteType, { id: quoted.messageId })
              : undefined
            const stickers = elements.filter((e) => e.type === 'sticker')
            const body = elements.filter(
              (e) => e.type !== 'sticker' && e.type !== quoteType
            )
            // The reference belongs to the first actual send, including a sticker-only message.
            if (body.some((e) => e.type !== 'text' || e.attrs.content.trim())) {
              await session.sendQueued(
                <>
                  {quote}
                  <markdown>{body}</markdown>
                </>
              )
              quote = undefined
            }
            const pool = llm.ctx.get('stickerPool')
            for (const sticker of stickers) {
              const img = pool?.resolve(sticker.attrs)
              if (!img) continue
              await session.sendQueued(quote ? [quote, img] : img)
              quote = undefined
            }
            sendFromIndex.value = next.nextIndex
          }
        }

        // 如果禁用 agent，临时使用一个空 registry
        const effectiveRegistry =
          llm.config.enableAgent === false ? new ToolRegistry() : llm.tools

        let agentResult: Awaited<ReturnType<typeof runAgentLoop>>
        try {
          agentResult = await runAgentLoop({
            ctx: llm.ctx,
            provider,
            messages: chatMessages,
            options: { model, maxTokens, temperature: 0.8, topP: 0.8 },
            features: { enableThinking, thinkingBudget, enableSearch },
            signal: abortController.signal,
            registry: effectiveRegistry,
            maxIterations: effectiveRegistry.iterationBudget(
              session,
              llm.config.maxToolIterations ?? 5
            ),
            showToolCallNotice: llm.config.showToolCallNotice ?? false,
            dsmlLeakMaxRetries: llm.config.dsmlLeakMaxRetries ?? 2,
            session,
            logger: llm.logger,
            onUserVisibleText: async (chunk) => {
              sendBuffer += chunk
              await flushVisibleText(false)
            },
            onDiscardVisible: () => {
              // DSML leak: drop everything streamed-but-not-yet-flushed this
              // turn (sendFromIndex marks the last flushed point), so the
              // re-rolled turn starts from a clean buffer. Already-flushed
              // text can't be unsent — rare for the short leak block, which
              // normally sits sub-threshold and unflushed.
              sendBuffer = sendBuffer.slice(0, sendFromIndex.value)
            },
            onAssistantRecord: async (record) => {
              activeEntry.wroteRecords = true
              await llm.ctx.database.create('openai_chat', {
                conversation_owner,
                conversation_id,
                role: 'assistant',
                content: record.content,
                reasoning_content: record.reasoningContent,
                tool_calls: record.toolCalls
                  ? JSON.stringify(record.toolCalls)
                  : undefined,
                usage: record.usage,
                model: record.model,
                time: record.time,
                turn_number: turnNumber,
                intra_turn_seq: nextSeq(),
              } as any)
            },
            onToolRecord: async (record) => {
              activeEntry.wroteRecords = true
              await llm.ctx.database.create('openai_chat', {
                conversation_owner,
                conversation_id,
                role: 'tool',
                content: record.content,
                reasoning_content: '',
                tool_call_id: record.toolCallId,
                tool_name: record.toolName,
                ...(record.images && { images: record.images }),
                time: record.time,
                turn_number: turnNumber,
                intra_turn_seq: nextSeq(),
              } as any)
            },
            turnState,
            drainSteer: (toolCalls) => {
              const items = activeEntry.inbox.splice(0)
              noteSpeakers(items)
              if (fromOthers(items))
                getMemoryToolState(turnState).othersSpoke = true
              const text = [wrapSteer(items), progressNudge.take(toolCalls) ? PROGRESS_NUDGE : '']
                .filter(Boolean)
                .join('\n\n')
              noteImageIds(turnState, text)
              const images = items.flatMap((item) => item.images ?? [])
              for (const id of images) turnImages(turnState).seen.add(id)
              return { text, images }
            },
            onTurnEnd: async () => {
              // 强制把这一轮累积的可见文本发出，作为一条独立消息——
              // 否则多轮工具调用之间的 prelude 都被攒到最后一股脑发出
              await flushVisibleText(true)
            },
          })
        } catch (e) {
          llm.logger.error('[chat] agent loop error:', e)
          await endTurn('failed', String((e as any)?.stack ?? e))
          llm.activeChats.unregister(scope.key)
          this.#runSteerLeftovers(scope.key, activeEntry)
          resolveCompletion()
          stopEmojiReaction()
          return describeChatError(e)
        }

        // SILENT 路径：agent 主动选择沉默，不发任何东西，emoji 提示用户
        // 收到了，整轮对话（user message + assistant <silent/>）都不入库——
        // 把"用户让我闭嘴 + 我闭了"当作系统控制信号处理，等价于 llm.stop。
        if (agentResult.silentChosen) {
          llm.logger.info('[chat] silent chosen by agent')
          await dropTurn()
          llm.activeChats.unregister(scope.key)
          this.#runSteerLeftovers(scope.key, activeEntry)
          resolveCompletion()
          stopEmojiReaction()
          session?.setReaction?.('🤐').catch(() => {})
          return
        }

        // 正常 / 被打断路径：剩余 buffer flush 一次（被打断时通常已经
        // flush 过，二次 flush 是 no-op）
        try {
          await flushVisibleText(true)
        } catch (e) {
          llm.logger.warn('[chat] final flush failed:', e)
        }
        stopEmojiReaction()

        if (agentResult.totalUsage && options.debug) {
          await session.sendQueued(
            h.text(JSON.stringify(agentResult.totalUsage, null, 2))
          )
        }

        const u = agentResult.totalUsage
        const cacheHitRate =
          u?.cachedTokens !== undefined && u.promptTokens
            ? `${((u.cachedTokens / u.promptTokens) * 100).toFixed(1)}%`
            : undefined
        llm.logger.success('[chat] agent end:', {
          iterations: agentResult.iterations,
          fullContent: agentResult.fullContent,
          usage: u,
          cacheHitRate,
          aborted: agentResult.aborted,
        })

        // An interrupt that left nothing but the user row: the interrupting
        // turn already carries this prompt (pre-stream merge), so drop it.
        if (agentResult.aborted && intraSeq === 0) await dropTurn()
        else await endTurn(agentResult.aborted ? 'aborted' : 'done')

        // 被打断时对方的 abort 已经触发（abort 早于这里）；正常完成时
        // 释放 activeChats 让下次 chat 能继续。
        llm.activeChats.unregister(scope.key)
        this.#runSteerLeftovers(scope.key, activeEntry)
        resolveCompletion()

        // 异步触发 memory fork（不阻塞主对话）。群会话不触发：fork 会拿
        // 整段会话历史给说话人写记忆，群里其他人的话会被写进去。
        if (!scope.shared) {
          llm.memoryFork
            .maybeTrigger({
              platform,
              userId,
              conversation_id,
              conversation_owner,
            })
            .catch((e) => llm.logger.warn('[memory-fork] schedule failed:', e))
        }
      })
  }
}
