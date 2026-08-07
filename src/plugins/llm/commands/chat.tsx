import { Context, Time, h } from 'koishi'

import crypto from 'node:crypto'

import { cancellableInterval } from '@/utils/cancellableDefferred'
import { getUserRoles } from '@/utils/formatSession'

import BasePlugin from '~/_boilerplate'

import { runAgentLoop } from '../agent-loop'
import type { ChatMessage } from '../providers/_base'
import { buildMemorySnapshot } from '../services/memory-snapshot'
import { ToolRegistry } from '../tools'
import { sanitizeAgentOutput } from '../utils/output-filter'
import { PROTOCOL_MARKERS, PROTOCOL_TAGS } from '../utils/protocol'
import {
  buildQuotedMessageBlock,
  extractQuoteMeta,
  resolveQuoteSeq,
} from '../utils/quoted-message'
import { splitContent } from '../utils/stream-splitter'
import { clampThinkingBudget, resolveThinkingLevel } from '../utils/thinking'

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

  /** Common error reply when the agent loop blows up. */
  private readonly RANDOM_ERROR_MSG = (
    <random>
      <template>SILI不知道喔。</template>
      <template>这道题SILI不会，长大后在学习~</template>
      <template>SILI的头好痒，不会要长脑子了吧？！</template>
      <template>锟斤拷锟斤拷锟斤拷</template>
    </random>
  )

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
      .check((_, content) => {
        if (!content?.trim()) return ''
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

        const startTime = Date.now()
        const conversation_owner = session.user.id
        // 本 chat invocation 在 conversation 内的 turn 编号；所有 row 共享。
        // 配合 intraSeq（user=0, 后续 ++）形成 history 的复合排序键。
        let turnNumber = -1
        let intraSeq = 0
        const nextSeq = () => ++intraSeq

        // 打断场景识别 + 等老会话退出
        let interruptScenario: 'fresh' | 'pre-stream' | 'mid-stream' = 'fresh'
        let interruptedOldPrompt = ''
        let inheritedConversationId: string | null = null
        const existingActive = llm.activeChats.get(conversation_owner)
        if (existingActive) {
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
          existingActive.abort.abort('user-interrupt')
          // 等老 session 真的 unwind（finally 解锁），避免和它的入库竞态
          await existingActive.completion.catch(() => {})
        }

        // 解析 conversation_id：
        // - 打断场景：直接用老 session 挂的 id（不读 user 字段，避免 race
        //   condition——老 action 还没 persist 时新 action 拉到的是旧值）
        // - 普通场景：读 user.openai_last_conversation_id；为空则生成新 UUID
        let conversation_id: string
        if (inheritedConversationId) {
          conversation_id = inheritedConversationId
          if (session.user.openai_last_conversation_id !== conversation_id) {
            session.user.openai_last_conversation_id = conversation_id
          }
        } else {
          conversation_id = session.user.openai_last_conversation_id ||=
            crypto.randomUUID()
        }

        const abortController = new AbortController()
        const sendFromIndexRef = { value: 0 }
        let resolveCompletion: () => void = () => {}
        const completion = new Promise<void>((res) => {
          resolveCompletion = res
        })
        llm.activeChats.register(conversation_owner, {
          abort: abortController,
          sendFromIndex: sendFromIndexRef,
          pendingUserPrompt: userPrompt ?? '',
          completion,
          conversationId: conversation_id,
        })

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
        const chatInfo = {
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
                '上一轮回复被用户打断。',
                `如果用户这条消息是要你停止说话（"闭嘴"、"别说了"、"打住"等），可以**仅**返回 ${PROTOCOL_MARKERS.SILENT}（不要带任何其他文字）来表示什么都不说。`,
                '其他情况正常回复，但不要重复或继续上一轮未说完的内容。',
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
        const quoteMeta = extractQuoteMeta(session)
        const quotedMessageBlock = quoteMeta
          ? buildQuotedMessageBlock(
              {
                ...quoteMeta,
                // The history cursor lets the agent read around an old message
                // instead of paging back from the newest one.
                seq: await resolveQuoteSeq(session.bot, session.quote?.id),
              },
              llm.config.quotedMessageMaxLength ?? 1000
            )
          : ''
        const userMessageBlock = [
          PROTOCOL_TAGS.USER_MESSAGE.open,
          userMessageBody,
          PROTOCOL_TAGS.USER_MESSAGE.close,
        ].join('\n')
        // Base envelope shapes — the optional memory snapshot prefix is
        // computed AFTER history load (we only seed memory on the first
        // turn of a fresh conversation, and post-compaction sessions
        // already carry the snapshot inside their summary user row).
        const persistableEnvelopeBase = [
          chatInfoBlock,
          quotedMessageBlock,
          userMessageBlock,
        ]
          .filter(Boolean)
          .join('\n')
        // The quote block belongs in the interrupt path too — being interrupted
        // doesn't make the user's quote any less relevant.
        const userMessageEnvelopeBase = interruptNoticeBlock
          ? [chatInfoBlock, interruptNoticeBlock, quotedMessageBlock, userMessageBlock]
              .filter(Boolean)
              .join('\n')
          : persistableEnvelopeBase

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
        let lastMessageId: string = session.messageId

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
          const idleTtlMs =
            llm.config.sessionIdleTimeoutMs ?? 3 * 24 * 60 * 60 * 1000
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
              session.user.openai_last_conversation_id = newId
              await session.user.$update()
              // activeChats entry 上挂的 id 也同步更新，避免后续打断
              // 进来读到老 id 又分歧
              const active = llm.activeChats.get(conversation_owner)
              if (active) active.conversationId = newId
            }
            await llm.sessions.create({
              conversationId: conversation_id,
              conversationOwner: conversation_owner,
              platform,
              userId,
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
            systemPrompt: systemPromptText,
            provider,
            model,
            platform,
            userId,
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
            session.user.openai_last_conversation_id =
              compactRes.newConversationId
            await session.user.$update()
            // ActiveChatRegistry entry is keyed by owner but caches the
            // conversation id; sync so a later interrupt sees the new id.
            const active = llm.activeChats.get(conversation_owner)
            if (active) active.conversationId = compactRes.newConversationId
          }
        } catch (e) {
          llm.logger.warn('[chat] summary compaction errored (non-fatal):', e)
        }

        const histories = await llm.chatHistory.getById(
          conversation_id,
          llm.config.historyTurnCount
        )
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
        const memoryPrefix =
          histories.length === 0
            ? await buildMemorySnapshot(
                llm.memory,
                platform,
                userId,
                llm.logger
              )
            : ''
        const persistableEnvelope = memoryPrefix
          ? `${memoryPrefix}\n\n${persistableEnvelopeBase}`
          : persistableEnvelopeBase
        const userMessageEnvelope = memoryPrefix
          ? `${memoryPrefix}\n\n${userMessageEnvelopeBase}`
          : userMessageEnvelopeBase

        chatMessages.push(
          { role: 'system', content: systemPromptText },
          ...histories,
          { role: 'user', content: userMessageEnvelope }
        )

        // 分配本 chat invocation 的 turn_number。在 session rotation 之后、
        // 任何 record 落库之前 allocate；ActiveChatRegistry 已经按 owner
        // 串行 chat，所以 in-memory counter 严格单调，被打断的老 chat 与
        // 后续新 chat 拿到的 turn_number 不会撞。
        turnNumber = await llm.turns.allocate(conversation_id)

        // 逐字流给用户的 helper
        const flushVisibleText = async (force: boolean) => {
          const next = force
            ? {
                // Force-flush mirrors splitContent's whitespace-suppression
                // policy — sending a buffer of trailing `\n` only would
                // surface as "[暂不支持的消息类型]" on QQ.
                text: sendBuffer.slice(sendFromIndex.value).trim()
                  ? sendBuffer.slice(sendFromIndex.value)
                  : '',
                nextIndex: sendBuffer.length,
              }
            : splitContent(sendBuffer, sendFromIndex.value, {
                maxChunkLen: 500,
              })
          if (next.text) {
            stopEmojiReaction()
            // 输出层处理：先按白名单过滤 element（防止 agent 乱用 <at> 等
            // 骚扰类 element），再把 <img ref="..."/> 还原成原始 base64 src
            // 让 koishi 真正发图。两步顺序无关——sanitize 不动 <img>，
            // resolveRefs 不动其他 element。
            const safeText = await llm.imageRefs.resolveRefsToDataUris(
              sanitizeAgentOutput(next.text)
            )
            const [msgId] = await session.sendQueued(
              (lastMessageId ? h.quote(lastMessageId) : '') + safeText
            )
            if (msgId) lastMessageId = msgId
          }
          sendFromIndex.value = next.nextIndex
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
            maxIterations: llm.config.maxToolIterations ?? 5,
            showToolCallNotice: llm.config.showToolCallNotice ?? true,
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
              await llm.ctx.database.create('openai_chat', {
                conversation_owner,
                conversation_id,
                role: 'tool',
                content: record.content,
                reasoning_content: '',
                tool_call_id: record.toolCallId,
                tool_name: record.toolName,
                time: record.time,
                turn_number: turnNumber,
                intra_turn_seq: nextSeq(),
              } as any)
            },
            onTurnEnd: async () => {
              // 强制把这一轮累积的可见文本发出，作为一条独立消息——
              // 否则多轮工具调用之间的 prelude 都被攒到最后一股脑发出
              await flushVisibleText(true)
            },
          })
        } catch (e) {
          llm.logger.error('[chat] agent loop error:', e)
          llm.activeChats.unregister(conversation_owner)
          resolveCompletion()
          stopEmojiReaction()
          return (
            <>
              <quote id={session.messageId}></quote>
              {this.RANDOM_ERROR_MSG}
            </>
          )
        }

        // SILENT 路径：agent 主动选择沉默，不发任何东西，emoji 提示用户
        // 收到了，整轮对话（user message + assistant <silent/>）都不入库——
        // 把"用户让我闭嘴 + 我闭了"当作系统控制信号处理，等价于 llm.stop。
        if (agentResult.silentChosen) {
          llm.logger.info('[chat] silent chosen by agent')
          llm.activeChats.unregister(conversation_owner)
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
            <>
              {lastMessageId && <quote id={lastMessageId}></quote>}
              {JSON.stringify(agentResult.totalUsage, null, 2)}
            </>
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

        // 落库 user 消息。排序由 (turn_number, intra_turn_seq) 决定，
        // user 永远 intra_turn_seq=0 是 turn 头；即使该 chat 被打断、
        // 中途有 record 先落库，user 仍排在 turn 起始。
        //
        // Persist the wrapped envelope (sans interrupt notice) so that the
        // bytes in db match what we SENT this turn for the user-message
        // position. Next turn replays this row at that exact position, so
        // the provider's prefix cache stays valid through it instead of
        // missing on the raw/wrapped mismatch. Behind a config flag while
        // we measure the cache-hit-rate impact in production.
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
        } as any)

        // 被打断时对方的 abort 已经触发（abort 早于这里）；正常完成时
        // 释放 activeChats 让下次 chat 能继续。
        llm.activeChats.unregister(conversation_owner)
        resolveCompletion()

        // 异步触发 memory fork（不阻塞主对话）
        llm.memoryFork
          .maybeTrigger({
            platform,
            userId,
            conversation_id,
            conversation_owner,
          })
          .catch((e) => llm.logger.warn('[memory-fork] schedule failed:', e))
      })
  }
}
