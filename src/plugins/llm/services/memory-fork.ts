import { Context, Logger } from 'koishi'

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  MemoryStore,
  NO_UPDATE_MAGIC,
  byteLength,
  isNoUpdateMagic,
} from './memory'
import type {
  ChatCompletionFeatures,
  ChatCompletionOptions,
  ChatMessage,
  LLMProviderBase,
  ToolDefinition,
} from '../providers/_base'
import { clampThinkingBudget } from '../utils/thinking'

const MEMORY_FORK_PROMPT_TEMPLATE = (() => {
  try {
    return readFileSync(
      resolve(import.meta.dirname, '../prompts/memory-fork.prompt.md'),
      'utf-8'
    )
  } catch {
    return ''
  }
})()

export interface MemoryForkInput {
  ctx: Context
  logger: Logger
  store: MemoryStore
  provider: LLMProviderBase
  model: string
  maxTokens: number
  /** Soft byte limit for the memory document. Hard limit = ceil(softLimit * 1.1). */
  byteLimit: number
  /** Maximum retries when the model output exceeds the hard limit. */
  maxRetries: number
  platform: string
  userId: string
  conversationId: string
  currentMessageCount: number
  history: ChatMessage[]
  /**
   * System prompt to use for the fork request. Should be byte-identical to
   * the main chat's system prompt — that's how we keep the [system + history]
   * prefix shared with the main conversation, so providers with automatic
   * prefix caching (e.g. DeepSeek) can serve fork at ~10% input price.
   * The reflection instructions live in the trailing user turn instead.
   */
  systemPrompt: string
  /**
   * Tool definitions to declare on the request. Should be the SAME list
   * the main chat uses (most providers serialize tools into the prefix
   * tokens — omitting them here would split the cache key on the very
   * next token after the system prompt). The fork itself has no business
   * invoking any tool, so we send `tool_choice: 'none'` to suppress
   * tool_calls without losing prefix-cache alignment.
   */
  tools?: ToolDefinition[]
}

const MEMORY_FORK_LOCKS = new Set<string>()

function lockKey(platform: string, userId: string): string {
  return `${platform}:${userId}`
}

export function isForkInProgress(platform: string, userId: string): boolean {
  return MEMORY_FORK_LOCKS.has(lockKey(platform, userId))
}

export async function maybeRunMemoryFork(
  input: MemoryForkInput
): Promise<void> {
  const key = lockKey(input.platform, input.userId)
  if (MEMORY_FORK_LOCKS.has(key)) return
  MEMORY_FORK_LOCKS.add(key)
  try {
    await runMemoryFork(input)
  } catch (e) {
    input.logger.warn('[memory-fork] failed:', e)
  } finally {
    MEMORY_FORK_LOCKS.delete(key)
  }
}

async function runMemoryFork(input: MemoryForkInput): Promise<void> {
  const existingMemory = await input.store.get(input.platform, input.userId)
  const softLimit = input.byteLimit
  const hardLimit = Math.ceil(softLimit * 1.1)

  // [system, ...history] 与主对话保持字节一致，让自动前缀缓存（DeepSeek 等）
  // 命中主对话上一轮留下的缓存；反思指令、当前记忆、字节上限、NO_UPDATE
  // 说明全部塞到末尾的单条 user turn 里，作为本次请求新增的非缓存部分。
  const reflectionUserPrompt = buildMemoryForkUserPrompt(
    existingMemory,
    softLimit,
    hardLimit
  )
  const messages: ChatMessage[] = [
    { role: 'system', content: input.systemPrompt },
    ...input.history.filter((m) => m.role !== 'system'),
    { role: 'user', content: reflectionUserPrompt },
  ]

  const options: ChatCompletionOptions = {
    model: input.model,
    maxTokens: input.maxTokens,
    temperature: 0.5,
    topP: 0.9,
    // Pass the same tools list as the main chat to keep prefix tokens
    // identical (cache hit), but force tool_choice='none' so the model
    // never actually emits tool_calls — fork's only job is to output
    // a memory document, not to invoke read/save/exec.
    tools: input.tools,
    toolChoice: input.tools && input.tools.length > 0 ? 'none' : undefined,
  }

  // memory fork 是反思任务，开 thinking 让模型先权衡再下笔
  const thinkingBudget = clampThinkingBudget(4096, input.maxTokens)
  const features: ChatCompletionFeatures = {
    enableThinking: thinkingBudget > 0,
    thinkingBudget,
  }

  for (let attempt = 1; attempt <= input.maxRetries; attempt++) {
    let collected = ''
    for await (const delta of input.provider.streamChatCompletion(
      messages,
      options,
      features
    )) {
      if (delta.kind === 'content') collected += delta.content
      if (delta.kind === 'error') throw delta.error
    }
    const trimmed = collected.trim()
    const size = byteLength(trimmed)

    input.logger.info(
      '[memory-fork] %s:%s attempt %d/%d, %d bytes',
      input.platform,
      input.userId,
      attempt,
      input.maxRetries,
      size
    )

    if (!trimmed) {
      input.logger.warn('[memory-fork] empty output (attempt %d)', attempt)
      messages.push({ role: 'assistant', content: collected })
      messages.push({
        role: 'user',
        content:
          '上次输出为空。请重新生成。如果确实没有值得记录的内容，' +
          `只输出魔法值 ${NO_UPDATE_MAGIC}。`,
      })
      continue
    }

    if (isNoUpdateMagic(trimmed)) {
      await input.store.markChecked(
        input.platform,
        input.userId,
        input.currentMessageCount,
        input.conversationId
      )
      return
    }

    if (size > hardLimit) {
      input.logger.warn(
        '[memory-fork] output %d bytes exceeds hard limit %d (attempt %d)',
        size,
        hardLimit,
        attempt
      )
      messages.push({ role: 'assistant', content: trimmed })
      messages.push({
        role: 'user',
        content:
          `上次输出 ${size} 字节，超过硬上限 ${hardLimit} 字节，已被拒绝。` +
          '必须更激进地遗忘不重要的内容，重新生成。' +
          `如果重新评估后觉得没有值得记录的，可以只输出 ${NO_UPDATE_MAGIC}。`,
      })
      continue
    }

    // 软限内或软-硬限之间，都接受
    if (size > softLimit) {
      input.logger.warn(
        '[memory-fork] output %d bytes over soft limit %d (within %d hard tolerance)',
        size,
        softLimit,
        hardLimit
      )
    }
    await input.store.set(
      input.platform,
      input.userId,
      trimmed,
      input.currentMessageCount,
      input.conversationId
    )
    return
  }

  // 重试用尽
  input.logger.warn(
    '[memory-fork] %s:%s exhausted %d retries, marking checked without update',
    input.platform,
    input.userId,
    input.maxRetries
  )
  await input.store.markChecked(
    input.platform,
    input.userId,
    input.currentMessageCount,
    input.conversationId
  )
}

/**
 * Format a Date as ISO date (YYYY-MM-DD) in the bot's local timezone.
 * Used to inject {{TODAY}} into the fork prompt so time-sensitive memory
 * entries can be timestamped without requiring the agent to infer the
 * date from `<turn_context>` blocks scattered through history.
 */
function formatToday(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Build the trailing user-turn content for a memory-fork request. All
 * reflection instructions live here (instead of in the system prompt) so
 * the [system + history] prefix can stay byte-identical to the main
 * conversation and benefit from automatic prefix caching.
 */
export function buildMemoryForkUserPrompt(
  existingMemory: string,
  softLimit: number,
  hardLimit: number,
  today: string = formatToday()
): string {
  const tpl = MEMORY_FORK_PROMPT_TEMPLATE
  if (!tpl) {
    // 兜底：模板文件读取失败时使用最小可用提示，避免任务直接挂
    return [
      '基于以上对话记录决定是否更新这位用户的长期记忆——这是离线反思任务，不要回复对话。',
      `如果没有值得保留的新信息，只输出 ${NO_UPDATE_MAGIC}。`,
      `否则输出完整的新记忆内容（markdown），不超过 ${softLimit} 字节，硬上限 ${hardLimit}。`,
      `时间敏感的事项请在末尾加 "（${today} 写入）" 后缀。`,
      '',
      '当前记忆：',
      existingMemory || '(空)',
    ].join('\n')
  }
  return tpl
    .replace(/\{\{EXISTING_MEMORY\}\}/g, existingMemory || '(空)')
    .replace(/\{\{SOFT_LIMIT\}\}/g, String(softLimit))
    .replace(/\{\{HARD_LIMIT\}\}/g, String(hardLimit))
    .replace(/\{\{NO_UPDATE_MAGIC\}\}/g, NO_UPDATE_MAGIC)
    .replace(/\{\{TODAY\}\}/g, today)
}
