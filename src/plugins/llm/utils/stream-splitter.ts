/**
 * 流式输出分片器：决定累积的 sendBuffer 何时切出一段发给用户。
 *
 * 在 koishi 这类「不能编辑已发消息」的平台上，把 LLM 的长流切成几条
 * 短消息发出。两条规则：
 *
 *   1. **AI 显式标记** `[koishi:msg_break]`：模型在合适处插入，看到就切。
 *      标记在 sanitize 阶段被丢弃。
 *   2. **超长 + 多行兜底**：仅在 agent **整段从未输出过任何 marker**
 *      的前提下生效。buffer 超过 maxChunkLen 且出现 `\n` 时切第一个
 *      `\n`，避免 agent 完全不切的情况下用户死等。
 *
 *      一旦 agent 出过任何一个 marker，就认为它已经接管了分段决策，
 *      系统不再兜底干预——典型场景是「先解释一段 + `[koishi:msg_break]` +
 *      然后 \`\`\`js 长示例代码块\`\`\`」，代码块容易超过 500 字但绝
 *      对不该被切到中间。
 *
 *      整段没换行（一连串没 \n 的长文）也不切，让 stream 完成时
 *      force-flush。永远不在句子中间硬切。
 */

import { PROTOCOL_MARKERS } from './protocol'

const MARKER = PROTOCOL_MARKERS.MSG_BREAK

export interface SplitOptions {
  /**
   * 触发"超长 + 多行"兜底切的阈值。AI 没标记 + buffer 超过这个长度 +
   * 出现 `\n` 时，切到第一个 `\n`。默认 500。
   */
  maxChunkLen?: number
  /** Emit the remaining text once all explicit break markers are consumed. */
  force?: boolean
}

export interface SplitResult {
  /** 这次该发出去的内容；空字符串表示"还不该切，继续累积"。 */
  text: string
  /** 切走 text 后的 buffer 起点（绝对位置）。 */
  nextIndex: number
}

/**
 * Build a result, suppressing whitespace-only payloads. Callers use
 * `if (next.text)` to decide whether to actually `sendQueued`; returning
 * `text: ''` makes the cursor advance past the slice without surfacing it
 * as an IM message. This matters because the fallback newline-cut can land
 * on the second `\n` of a `\n\n` paragraph break, yielding a single-`\n`
 * chunk that onebot renders as "[暂不支持的消息类型]" on QQ.
 */
function emit(slice: string, nextIndex: number): SplitResult {
  return { text: slice.trim() ? slice : '', nextIndex }
}

export function isAgentMessageStart(
  buffer: string,
  fromIndex: number
): boolean {
  return fromIndex === 0 || buffer.endsWith(MARKER, fromIndex)
}

export function splitContent(
  buffer: string,
  fromIndex: number,
  opts: SplitOptions = {}
): SplitResult {
  const maxLen = opts.maxChunkLen ?? 500

  if (fromIndex >= buffer.length) {
    return { text: '', nextIndex: buffer.length }
  }
  const rest = buffer.slice(fromIndex)

  // 1. AI 显式标记
  const markerIdx = rest.indexOf(MARKER)
  if (markerIdx >= 0) {
    const cut = markerIdx + MARKER.length
    return emit(rest.slice(0, cut), fromIndex + cut)
  }

  if (opts.force) return emit(rest, buffer.length)

  // 2. 超长 + 多行兜底——**仅当** agent 整段从未输出过 marker 才触发。
  // 一旦它表态过想分段（哪怕只一次），就让它接管：当前可能在写代码块
  // 等不该被切的内容，系统不再插手。
  //
  // 切点要求：rest 已达 maxLen，且切片本身 >= maxLen/2 字符。后者避免
  // AI 满篇 `\n\n` 段落分隔时，第一次切完后 cursor 落在下一段开头，
  // rest 仍 >= maxLen → 又在很近的 \n 处切出一条 5 字消息的级联问题。
  // 找一个"距 cursor 至少 maxLen/2 处之后"的 \n，保证每段兜底输出都
  // 有实际分量。
  const agentOptedIn = buffer.indexOf(MARKER) !== -1
  if (!agentOptedIn && rest.length >= maxLen) {
    const minSliceLen = Math.floor(maxLen / 2)
    const nl = rest.indexOf('\n', minSliceLen)
    if (nl >= 0) {
      const cut = nl + 1
      return emit(rest.slice(0, cut), fromIndex + cut)
    }
  }

  return { text: '', nextIndex: fromIndex }
}
