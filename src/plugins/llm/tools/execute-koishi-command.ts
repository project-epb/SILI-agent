import type { Context, Session } from '@koishijs/core'

import {
  type CommandCatalogEntry,
  findCatalogEntry,
  renderCatalogEntryDetail,
} from '../utils/command-catalog'
import type { ImageReferenceCache } from '../services/image-cache'
import type { ToolDefinition } from '../providers/_base'

import type { ToolHandler } from './types'

export const EXECUTE_KOISHI_COMMAND_TOOL: ToolDefinition = {
  name: 'execute_koishi_command',
  description: [
    '以当前用户的身份执行一条 Koishi 指令。可用指令清单见 system prompt 的「可用指令」章节——清单里看到的就是 `name` 该传的值，MUST NOT 做额外加工；清单中不存在的指令 MUST NOT 凭空调用。',
    '',
    '**清单只是概览**，没有列出参数、选项、子指令。首次调用前 MUST use `help`：',
    '`{name: "help", args: ["指令名"]}` → 返回描述/参数/选项/别名/子指令。',
    '',
    '**命名规则**（Koishi 把命名空间和分类用不同符号区分）：',
    '- `foo.bar` （**点号** = 命名空间）→ `name: "foo.bar"`',
    '- `foo/bar` （**斜杠** = 分类）→ `name: "bar"`（foo 仅用于分组）',
    '- 顶级指令直接传 `name: "homo"`',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: "指令的完整路径名，如 'foo' 或 'foo.bar'",
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: '位置参数列表，按指令定义的顺序传入',
      },
      options: {
        type: 'object',
        description: '选项 key-value，key 是选项名（不含 -- 前缀）',
        additionalProperties: true,
      },
    },
    required: ['name'],
  },
}

export interface ExecuteKoishiCommandInput {
  name: string
  args?: string[]
  options?: Record<string, any>
}

/**
 * Commands the agent must not invoke. These are user-facing controls over
 * the agent itself (chat would recurse; llm.* manage memory/sessions/
 * providers and the user — not the AI — should drive them).
 */
const FORBIDDEN_AGENT_COMMANDS = new Set(['chat', 'llm'])

export function isForbiddenAgentCommand(name: string): boolean {
  if (FORBIDDEN_AGENT_COMMANDS.has(name)) return true
  if (name.startsWith('llm.')) return true
  return false
}

/**
 * Render an agent-friendly help payload. Pure — takes the catalog directly.
 * - No args: list top-level commands (one line each).
 * - First arg = command name: render that entry's full detail.
 * - Unknown command: returns an error message asking the agent to retry.
 */
export function renderAgentHelp(
  catalog: readonly CommandCatalogEntry[],
  queryName?: string
): string {
  if (!queryName) {
    if (!catalog.length) return '(暂无可用指令)'
    const lines = catalog.map(
      (e) => `- \`${e.name}\` — ${e.description?.trim() || '(无描述)'}`
    )
    return ['# 可用指令（顶级）', '', ...lines].join('\n')
  }
  const entry = findCatalogEntry(catalog, queryName)
  if (!entry) {
    return `Error: command "${queryName}" not found in catalog. 可用指令名见上文清单；不要传 \`foo bar\` 这种带空格的形式（应为 \`foo.bar\` 或仅 \`bar\`）。`
  }
  return renderCatalogEntryDetail(entry)
}

async function runExecuteKoishiCommand(
  session: Session,
  input: ExecuteKoishiCommandInput,
  ctx: Context
): Promise<string> {
  if (!input?.name || typeof input.name !== 'string') {
    return 'Error: tool input missing required field "name"'
  }
  if (isForbiddenAgentCommand(input.name)) {
    return `Error: command "${input.name}" is reserved for direct user control and cannot be invoked from agent context.`
  }

  // 拦截 help: koishi 原生 help 把 wiki.connect 显示成 "wiki connect"，
  // 把 llm/chat 也显示成 "llm chat"，AI 无法分辨命名空间和分类。我们用
  // 自己的 catalog 数据按真实 name 渲染，避免误导。
  if (input.name === 'help') {
    const llm = (ctx as any).llm as
      | { getCatalog?: () => readonly CommandCatalogEntry[] }
      | undefined
    const catalog = llm?.getCatalog?.() ?? []
    return renderAgentHelp(catalog, input.args?.[0])
  }

  // 部分 koishi 插件违反开发规范，在 action 里直接 session.send 而不是
  // return string（典型例子：mediawiki 插件）。我们在底层 bot.sendMessage
  // 这一层劫持——session.send / sendQueued 最终都会走到这里——把这些
  // "侧通道"产出收集起来，合并到工具返回值里，让 agent 拿到完整结果。
  //
  // 为什么不在 session.send 层劫持：cordis 的 service mixin 用 accessor +
  // Proxy 实现，instance 层 own property override 看似生效但实际调用
  // 仍走 service routing，拦不到。bot 是普通 Bot class instance，没有
  // service 装饰，own property override 100% 可靠。
  //
  // 精准条件：只拦 options.session === currentSession 的发送，避免影响
  // 同时间内别的并发用户/会话。窗口严格在 session.execute 调用前后，
  // try/finally 还原。
  const captured: string[] = []
  const stringifyFragment = (content: unknown): string => {
    if (content == null) return ''
    if (typeof content === 'string') return content
    // koishi fragment is usually Element[] — concat-toString instead of the
    // default Array.toString which inserts commas between elements.
    if (Array.isArray(content)) return content.map((e) => String(e)).join('')
    return String(content)
  }
  const collect = (content: unknown) => {
    const text = stringifyFragment(content)
    if (text) captured.push(text)
  }
  const bot = (session as any).bot
  const originalBotSendMessage = bot?.sendMessage?.bind(bot)
  if (originalBotSendMessage) {
    bot.sendMessage = async function (
      channelId: string,
      content: unknown,
      referrer?: unknown,
      options?: any
    ) {
      if (options?.session === session) {
        collect(content)
        return [] as string[]
      }
      return originalBotSendMessage(channelId, content, referrer, options)
    }
  }

  try {
    const result = await session.execute(
      {
        name: input.name,
        args: input.args || [],
        options: input.options || {},
      },
      true
    )
    const returned = stringifyFragment(result)
    const rawAggregated = [captured.join('\n'), returned]
      .filter((s) => s && s.trim())
      .join('\n')
      .trim()
    if (!rawAggregated) return '(指令未返回任何输出)'
    // Token-saving: collapse inline base64 image data URIs into short refs
    // before handing the result to the agent. Refs are restored to the
    // original src on the way back out (see flushVisibleText).
    const imageRefs = (ctx as any).llm?.imageRefs as
      | ImageReferenceCache
      | undefined
    return imageRefs
      ? await imageRefs.replaceDataUrisWithRefs(rawAggregated)
      : rawAggregated
  } catch (e: any) {
    return `Error: ${e?.message || String(e)}`
  } finally {
    if (originalBotSendMessage) bot.sendMessage = originalBotSendMessage
  }
}

export const executeKoishiCommandHandler: ToolHandler = {
  definition: EXECUTE_KOISHI_COMMAND_TOOL,
  async execute(args, { ctx, session }) {
    return runExecuteKoishiCommand(
      session,
      args as ExecuteKoishiCommandInput,
      ctx
    )
  },
}
