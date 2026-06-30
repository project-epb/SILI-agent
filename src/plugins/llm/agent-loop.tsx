import { Context, Logger, Session } from 'koishi'

import { LLMProviderBase } from './providers/_base'
import type {
  ChatCompletionFeatures,
  ChatCompletionOptions,
  ChatCompletionUsage,
  ChatMessage,
  ToolCall,
} from './providers/_base'
import { PROTOCOL_MARKERS } from './utils/protocol'
import { containsDsmlLeak } from './utils/dsml-leak'
import { ToolRegistry } from './tools'

const { SILENT: SILENT_MARKER, INTERRUPTED: INTERRUPTED_MARKER, MSG_BREAK: MSG_BREAK_MARKER } =
  PROTOCOL_MARKERS

/**
 * Compute what to persist when the assistant turn is interrupted.
 *
 * If the agent had emitted any `<msg_break/>` markers, the user has
 * already seen everything up to the last marker (splitContent flushes at
 * each marker). Truncate at that marker and replace it with
 * `<interrupted/>` so history reflects exactly what the user saw, no
 * speculatively-streamed-but-unflushed tail.
 *
 * If no marker, append `<interrupted/>` to the raw content. This still
 * over-records by the maxLen-fallback split point (rare), but is the
 * best agent-loop can do without coupling to chat.tsx's sendFromIndex.
 */
function buildInterruptedContent(content: string): string {
  if (!content) return ''
  const lastMarker = content.lastIndexOf(MSG_BREAK_MARKER)
  if (lastMarker !== -1) {
    return content.slice(0, lastMarker) + INTERRUPTED_MARKER
  }
  return content + '\n' + INTERRUPTED_MARKER
}

/**
 * Thrown when the DeepSeek "DSML leak" bug (see utils/dsml-leak.ts) keeps
 * corrupting the stream past `dsmlLeakMaxRetries` re-sends of the same
 * payload. The caller (chat.tsx) catches this like any other agent-loop
 * failure and shows its graceful fallback reply instead of the garbage.
 */
export class DsmlLeakUnrecoverableError extends Error {
  constructor(retries: number) {
    super(`DSML leak persisted after ${retries} retr${retries === 1 ? 'y' : 'ies'}`)
    this.name = 'DsmlLeakUnrecoverableError'
  }
}

export interface AgentLoopOptions {
  ctx: Context
  provider: LLMProviderBase
  messages: ChatMessage[]                   // 包含 system，会被复制
  options: ChatCompletionOptions             // 含 tools
  features?: ChatCompletionFeatures
  registry: ToolRegistry                    // 工具注册表
  maxIterations: number
  showToolCallNotice: boolean
  /**
   * Max times to re-send the SAME payload when a DeepSeek "DSML leak"
   * (utils/dsml-leak.ts) corrupts the assistant content. These retries do
   * NOT consume the tool-iteration budget — it's the same logical turn,
   * just re-rolled. 0 disables the workaround. Exhausting it throws
   * DsmlLeakUnrecoverableError. Default 2.
   */
  dsmlLeakMaxRetries?: number
  session: Session
  logger: Logger
  /** Optional signal to interrupt mid-loop. Aborts the in-flight LLM stream,
   *  bails out of subsequent iterations, and skews input/output bookkeeping
   *  so partial assistant text is preserved with an `<interrupted/>` marker. */
  signal?: AbortSignal
  onUserVisibleText: (text: string) => Promise<void>
  /**
   * Drop any visible text streamed via onUserVisibleText this turn that the
   * caller has buffered but not yet flushed to the user. Called when a DSML
   * leak is detected so the partial garbage (and any legit prelude that
   * preceded it) is discarded before the payload is re-sent — the re-roll
   * regenerates the whole assistant turn from scratch.
   */
  onDiscardVisible?: () => Promise<void> | void
  onAssistantRecord: (record: AssistantTurnRecord) => Promise<void>
  onToolRecord: (record: ToolTurnRecord) => Promise<void>
  /**
   * Called after each iteration's stream finishes consuming. Lets the
   * caller force-flush any buffered visible text before tool execution
   * starts, so the model's pre-tool "let me check..." line surfaces as
   * its own message instead of getting concatenated with later turns'
   * text into one wall.
   */
  onTurnEnd?: (info: { hadToolCalls: boolean }) => Promise<void>
}

export interface AssistantTurnRecord {
  content: string
  reasoningContent: string
  toolCalls?: ToolCall[]
  usage?: ChatCompletionUsage
  model: string
  time: number
}

export interface ToolTurnRecord {
  toolCallId: string
  toolName: string
  content: string
  time: number
}

export interface AgentLoopResult {
  fullContent: string
  totalUsage?: ChatCompletionUsage
  iterations: number
  /** True if the loop bailed because of opts.signal.aborted. */
  aborted: boolean
  /** True if the agent emitted SILENT_MARKER as its full response — caller
   *  should suppress UI output AND skip writing this turn's user message. */
  silentChosen: boolean
}

export async function runAgentLoop(
  opts: AgentLoopOptions
): Promise<AgentLoopResult> {
  const messages = [...opts.messages]
  let iterations = 0
  let lastFullContent = ''
  let totalUsage: ChatCompletionUsage | undefined
  let silentChosen = false

  // Fresh per-turn state shared across tool executions in this loop.
  // Lets read_user_memory hand off `last_updated_at` to save_user_memory
  // (read-before-write + optimistic-lock).
  const turnState: Record<string, unknown> = {}

  const allTools = opts.registry.listDefinitions()
  const isAborted = () => opts.signal?.aborted === true

  outer: while (iterations < opts.maxIterations) {
    if (isAborted()) break
    iterations++
    const isLastAllowed = iterations >= opts.maxIterations

    const callOptions: ChatCompletionOptions = {
      ...opts.options,
      tools: isLastAllowed || allTools.length === 0 ? undefined : allTools,
      toolChoice: isLastAllowed ? undefined : opts.options.toolChoice ?? 'auto',
    }

    let currentContent = ''
    let currentReasoning = ''
    let collectedToolCalls: ToolCall[] = []
    let lastError: Error | undefined
    let usage: ChatCompletionUsage | undefined
    let streamAborted = false
    /**
     * Time the assistant turn finished streaming (or was aborted). Captured
     * here — not at write-to-db time — so the persisted `time` field reflects
     * actual stream order, not the moment we *finished waiting for tools*.
     * Without this, an assistant message that defers persistence until tools
     * complete ends up with a `time` LATER than the tool results' `time`,
     * which breaks groupAndTrimHistory's turn ordering on read-back.
     */
    let assistantTurnTime = 0

    // ---- DSML-leak workaround ----
    // DeepSeek hosts occasionally dump the model's tool-call markup as plain
    // content (see utils/dsml-leak.ts). When that happens, discard the
    // garbled attempt and re-send the SAME payload. These re-rolls do NOT
    // consume the tool-iteration budget (`iterations` already incremented;
    // we loop here, not back to `outer`). Exhausting the retries throws so
    // the caller shows a graceful fallback instead of the garbage.
    const dsmlMaxRetries = opts.dsmlLeakMaxRetries ?? 2
    let dsmlRetries = 0
    let dsmlLeaked = false
    dsml: while (true) {
      // Reset per-attempt accumulators (a re-roll starts the turn over).
      currentContent = ''
      currentReasoning = ''
      collectedToolCalls = []
      lastError = undefined
      usage = undefined
      streamAborted = false
      dsmlLeaked = false

      const stream = opts.provider.streamChatCompletion(
        messages,
        callOptions,
        { ...opts.features, signal: opts.signal }
      )

      try {
        for await (const delta of stream) {
          if (isAborted()) {
            streamAborted = true
            break
          }
          switch (delta.kind) {
            case 'reasoning_content':
              currentReasoning += delta.content
              break
            case 'content':
              currentContent += delta.content
              // Detect on the ACCUMULATED content — the sentinel can straddle
              // chunk boundaries. Once it fires, stop forwarding: the rest of
              // this stream is garbage we're about to discard, and we don't
              // want it growing past the split threshold and flushing.
              if (containsDsmlLeak(currentContent)) {
                dsmlLeaked = true
                break
              }
              await opts.onUserVisibleText(delta.content)
              break
            case 'tool_call':
              collectedToolCalls.push(delta.toolCall)
              break
            case 'usage':
              usage = delta.usage
              break
            case 'error':
              lastError = delta.error
              break
            case 'finish':
              break
          }
          if (dsmlLeaked) break
        }
      } catch (e: any) {
        // SDKs throw AbortError when the upstream signal fires — treat as
        // graceful interrupt rather than a failure to surface.
        if (isAborted() || e?.name === 'AbortError') {
          streamAborted = true
        } else {
          throw e
        }
      }

      // Count tokens spent on this attempt — even a leaked one really billed.
      if (usage) totalUsage = mergeUsage(totalUsage, usage)

      if (dsmlLeaked && !isAborted()) {
        // Drop the partial garbage (+ any legit prelude) the caller buffered
        // but hasn't shown yet; the re-roll regenerates the turn from scratch.
        await opts.onDiscardVisible?.()
        if (dsmlRetries < dsmlMaxRetries) {
          dsmlRetries++
          opts.logger.warn(
            '[agent] DSML leak detected, re-sending payload (retry %d/%d)',
            dsmlRetries,
            dsmlMaxRetries
          )
          continue dsml
        }
        opts.logger.error(
          '[agent] DSML leak persisted after %d retr%s, giving up',
          dsmlMaxRetries,
          dsmlMaxRetries === 1 ? 'y' : 'ies'
        )
        throw new DsmlLeakUnrecoverableError(dsmlMaxRetries)
      }

      break dsml
    }

    // Reached here with dsmlLeaked still set means the leak and the user's
    // interrupt raced on the same attempt (so we neither retried nor threw).
    // Fall through as a clean abort: drop the garbage, persist nothing.
    if (dsmlLeaked) {
      await opts.onDiscardVisible?.()
      currentContent = ''
      currentReasoning = ''
      streamAborted = true
    }

    if (lastError && !streamAborted) throw lastError

    // Pin assistant turn time NOW — before any tool dispatch. If we wait
    // until persistence (which happens after all tools complete), the
    // assistant `time` ends up later than the tool results' `time` and
    // history sort puts tool before assistant.
    assistantTurnTime = Date.now()

    // ---- Stream-level abort: bail before considering tool calls ----
    if (streamAborted) {
      if (currentContent) {
        await opts.onAssistantRecord({
          content: buildInterruptedContent(currentContent),
          reasoningContent: currentReasoning,
          toolCalls: undefined,
          usage,
          model: opts.options.model,
          time: assistantTurnTime,
        })
      }
      lastFullContent = currentContent
      break
    }

    // ---- SILENT marker: agent chose to stay quiet ----
    // Skip persistence so history doesn't carry this non-conversation; the
    // caller will also drop the current user message.
    if (currentContent.trim() === SILENT_MARKER) {
      silentChosen = true
      lastFullContent = ''
      break
    }

    // ---- No tool calls: normal terminal turn ----
    if (collectedToolCalls.length === 0) {
      await opts.onAssistantRecord({
        content: currentContent,
        reasoningContent: currentReasoning,
        toolCalls: undefined,
        usage,
        model: opts.options.model,
        time: assistantTurnTime,
      })
      await opts.onTurnEnd?.({ hadToolCalls: false })
      lastFullContent = currentContent
      break
    }

    // ---- Tool calls present ----
    // Defer assistant record persistence until we know whether the tools
    // complete: if abort fires during tool execution we want to write the
    // turn as `<interrupted/>` (no tool_calls) so history stays well-formed.
    await opts.onTurnEnd?.({ hadToolCalls: true })

    // Push assistant turn to in-memory messages so subsequent tool messages
    // form a valid OpenAI/Anthropic conversation when we DO continue.
    messages.push({
      role: 'assistant',
      content: currentContent,
      tool_calls: collectedToolCalls,
    })

    const completedToolMessages: Array<{
      tc: ToolCall
      resultText: string
      time: number
    }> = []

    for (const tc of collectedToolCalls) {
      if (isAborted()) {
        // Don't even start more tools after abort.
        break
      }
      if (opts.showToolCallNotice) {
        // tc.name is the LLM tool name (execute_koishi_command), opaque to
        // users; show the real koishi command name from arguments instead.
        const args = tc.arguments as any
        const displayName =
          tc.name === 'execute_koishi_command' && args?.name
            ? args.name
            : tc.name
        await opts.session
          .send(<>[正在执行: {displayName}]</>)
          .catch(() => {})
      }
      opts.logger.info('[agent] tool call:', tc.name, tc.arguments)
      const resultText = await dispatchTool(opts, tc, turnState)
      opts.logger.info(
        '[agent] tool result:',
        tc.name,
        resultText.slice(0, 200)
      )
      // Check abort AFTER tool finishes. We can't cancel a running koishi
      // command — let it finish, then drop the result if user has moved on.
      if (isAborted()) break
      completedToolMessages.push({
        tc,
        resultText,
        time: Date.now(),
      })
    }

    if (isAborted()) {
      // Tool round-trip didn't complete cleanly. Persist assistant as
      // interrupted (no tool_calls field) and drop the partial tool
      // results. History stays well-formed: user → assistant<interrupted/>.
      if (currentContent) {
        await opts.onAssistantRecord({
          content: buildInterruptedContent(currentContent),
          reasoningContent: currentReasoning,
          toolCalls: undefined,
          usage,
          model: opts.options.model,
          time: assistantTurnTime,
        })
      }
      lastFullContent = currentContent
      break outer
    }

    // ---- All tools finished cleanly; persist the full turn ----
    await opts.onAssistantRecord({
      content: currentContent,
      reasoningContent: currentReasoning,
      toolCalls: collectedToolCalls,
      usage,
      model: opts.options.model,
      time: assistantTurnTime,
    })
    for (const m of completedToolMessages) {
      messages.push({
        role: 'tool',
        tool_call_id: m.tc.id,
        tool_name: m.tc.name,
        content: m.resultText,
      })
      await opts.onToolRecord({
        toolCallId: m.tc.id,
        toolName: m.tc.name,
        content: m.resultText,
        time: m.time,
      })
    }
    lastFullContent = currentContent
  }

  return {
    fullContent: lastFullContent,
    totalUsage,
    iterations,
    aborted: isAborted(),
    silentChosen,
  }
}

async function dispatchTool(
  opts: AgentLoopOptions,
  tc: ToolCall,
  turnState: Record<string, unknown>
): Promise<string> {
  const handler = opts.registry.get(tc.name)
  if (!handler) return `Error: unknown tool "${tc.name}"`
  try {
    return await handler.execute(tc.arguments, {
      ctx: opts.ctx,
      logger: opts.logger,
      session: opts.session,
      turnState,
    })
  } catch (e: any) {
    return `Error: ${e?.message || String(e)}`
  }
}

function mergeUsage(
  a: ChatCompletionUsage | undefined,
  b: ChatCompletionUsage
): ChatCompletionUsage {
  if (!a) return b
  // `undefined + defined` stays `defined` (e.g., only one provider reported
  // cached/reasoning) — addUndef preserves the value when one side is
  // missing, sums when both are present, and stays undefined when neither
  // reported, so a 0 in the log unambiguously means "reported zero" rather
  // than "never reported".
  const addUndef = (x?: number, y?: number): number | undefined => {
    if (x === undefined && y === undefined) return undefined
    return (x ?? 0) + (y ?? 0)
  }
  return {
    promptTokens: addUndef(a.promptTokens, b.promptTokens),
    completionTokens: addUndef(a.completionTokens, b.completionTokens),
    totalTokens: addUndef(a.totalTokens, b.totalTokens),
    cachedTokens: addUndef(a.cachedTokens, b.cachedTokens),
    reasoningTokens: addUndef(a.reasoningTokens, b.reasoningTokens),
  }
}
