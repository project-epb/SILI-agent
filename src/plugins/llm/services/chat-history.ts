import type { Context } from '@koishijs/core'

import { type HistoryRow, groupAndTrimHistory } from './history-filter'
import type { ChatMessage, ToolCall } from '../providers/_base'

/**
 * Read & shape persisted chat history into the ChatMessage[] format the
 * LLM provider expects. Implements a two-phase approach:
 *
 *  1. Pull the most recent rows by descending time (cap to 200 to avoid
 *     unbounded queries even when the caller requests a large turn limit).
 *  2. Pass them through groupAndTrimHistory which understands turn
 *     boundaries (1 user + N assistant tool_calls + N tool + 1 final
 *     assistant) and returns the most recent N completed turns.
 *
 * `reasoning_content` is always populated (even with empty string) so the
 * provider layer can decide whether to keep it based on the target model.
 */
export class ChatHistoryService {
  constructor(private readonly ctx: Context) {}

  /**
   * Count user-role rows for a conversation. Used by SummaryCompactor to
   * decide when to rotate. Cheaper than `getById().filter(...)` because
   * it only pulls the `id` column.
   */
  async countUserMessages(conversation_id: string): Promise<number> {
    const rows = (await this.ctx.database.get(
      'openai_chat',
      { conversation_id, role: 'user' },
      { fields: ['id'] }
    )) as Array<{ id: number }> | null
    return rows?.length ?? 0
  }

  async getById(
    conversation_id: string,
    limit = 10
  ): Promise<ChatMessage[]> {
    const userTurnLimit = Math.max(0, Math.floor(limit))
    if (!userTurnLimit) return []

    // 一个回合最多 1 user + N assistant(tool_calls) + N tool + 1 final assistant
    const queryLimit = Math.min(200, userTurnLimit * 8 + 20)

    // 排序依据：复合 key (turn_number, intra_turn_seq)。
    // - turn_number：本 chat invocation 的编号，per-conversation 单调
    //   递增，由 TurnAllocator 分配；保证不同 chat 的 row 不会交叉。
    // - intra_turn_seq：turn 内顺序，user=0 永远是 turn 头；后续
    //   assistant/tool 由 chat 处理器按 ++seq 写入。
    // - id 作为最终 tie-break（理论上前两个 key 已唯一，加 id 保稳定排序）。
    // 老 wall-clock 路径下"相邻 record 撞同毫秒"和"被打断 assistant 时间
    // 晚于打断者 user 的 startTime"两类问题在新 sort 键下都消失。
    const raw = (await this.ctx.database.get(
      'openai_chat',
      { conversation_id },
      {
        sort: { turn_number: 'desc', intra_turn_seq: 'desc', id: 'desc' },
        limit: queryLimit,
        fields: [
          'content',
          'role',
          'reasoning_content',
          'tool_calls',
          'tool_call_id',
          'tool_name',
        ],
      }
    )) as Array<HistoryRow & { reasoning_content?: string }> | null

    const rowsAsc = (raw ?? []).slice().reverse()
    const trimmed = groupAndTrimHistory(rowsAsc, userTurnLimit)

    return trimmed.map((row): ChatMessage => {
      if (row.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: row.tool_call_id ?? '',
          tool_name: row.tool_name ?? '',
          content: row.content,
        }
      }
      if (row.role === 'assistant') {
        const tool_calls = row.tool_calls
          ? (JSON.parse(row.tool_calls) as ToolCall[])
          : undefined
        return {
          role: 'assistant',
          content: row.content,
          tool_calls,
          reasoning_content: row.reasoning_content ?? '',
        }
      }
      return { role: row.role as 'user' | 'system', content: row.content }
    })
  }
}
