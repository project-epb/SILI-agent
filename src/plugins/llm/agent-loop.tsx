import { Context, Logger, Session } from 'koishi'

import { LLMProviderBase } from './providers/_base'
import type {
  ChatCompletionFeatures,
  ChatCompletionOptions,
  ChatCompletionUsage,
  ChatMessage,
  ToolCall,
} from './providers/_base'
import { PROTOCOL_MARKERS, escapeProtocolTags } from './utils/protocol'
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
  /** Optional signal to interrupt mid-loop. Aborts the in-flight LLM stream
   *  and bails out of subsequent iterations: partial assistant text is
   *  preserved with an `<interrupted/>` marker, tools that already ran keep
   *  their stored results. */
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
  /**
   * Steer: messages that arrived while this turn runs, already wrapped as
   * envelopes, or '' when there are none. Drained once all tools of an
   * iteration have finished and appended to that iteration's last tool
   * result, so the next request sees them without breaking the
   * assistant/tool message order. Whatever arrives after the last tool
   * iteration stays with the caller, to run as a turn of its own.
   */
  drainSteer?: () => string
  /**
   * Per-turn state shared across tool executions (see ToolContext). The
   * caller may pass its own to set state up front; a fresh one otherwise.
   */
  turnState?: Record<string, unknown>
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
  const turnState: Record<string, unknown> = opts.turnState ?? {}

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
    /** Time the assistant turn finished streaming (or was aborted). */
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
    await opts.onTurnEnd?.({ hadToolCalls: true })

    // Stored before any tool runs, and each result the moment it exists: a
    // tool that ran had its effect, so history must show it even if the turn
    // dies right after (crash, provider error, user interrupt). A call left
    // without a result is answered with a placeholder when history is read.
    await opts.onAssistantRecord({
      content: currentContent,
      reasoningContent: currentReasoning,
      toolCalls: collectedToolCalls,
      usage,
      model: opts.options.model,
      time: assistantTurnTime,
    })
    messages.push({
      role: 'assistant',
      content: currentContent,
      tool_calls: collectedToolCalls,
    })

    for (const [index, tc] of collectedToolCalls.entries()) {
      if (isAborted()) break
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
      // Tool output comes from outside (web pages, chat history): a forged
      // envelope tag in it must not read as a real message.
      let resultText = escapeProtocolTags(await dispatchTool(opts, tc, turnState))
      opts.logger.info(
        '[agent] tool result:',
        tc.name,
        resultText.slice(0, 200)
      )
      // Steer rides on the iteration's last result, drained once every tool
      // has finished; skipped when interrupted so it runs as its own turn.
      if (index === collectedToolCalls.length - 1 && !isAborted()) {
        const steer = opts.drainSteer?.()
        if (steer) resultText += `\n\n${steer}`
      }
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        tool_name: tc.name,
        content: resultText,
      })
      await opts.onToolRecord({
        toolCallId: tc.id,
        toolName: tc.name,
        content: resultText,
        time: Date.now(),
      })
    }

    if (isAborted()) {
      lastFullContent = currentContent
      break outer
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
