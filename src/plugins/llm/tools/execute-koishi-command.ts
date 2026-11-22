import type { Context, Session } from 'koishi'

import type { ToolDefinition } from '../providers/_base'
import type { ImageReferenceCache } from '../services/image-cache'
import {
  type CommandCatalogEntry,
  findCatalogEntry,
  renderCatalogEntryDetail,
  searchCatalogEntries,
} from '../utils/command-catalog'
import { describeSpeaker, pickSpeaker } from '../utils/turn-speakers'
import type { ToolHandler } from './types'

export const EXECUTE_KOISHI_COMMAND_TOOL: ToolDefinition = {
  name: 'execute_koishi_command',
  description: [
    '以某个用户的身份执行一条 Koishi 指令：权限按他算，改名、签到这类指令也作用在他身上。系统提示词的「可用指令」列出顶层指令。调用时直接使用帮助或清单返回的完整指令名。',
    '',
    '- 身份：这一轮只有一个人说话时可省略 `as_uid`；有两人及以上说过话时必须传，填这条指令是为谁执行的那个人的 `turn_context.koishi.uid`。',
    '',
    '- 查找指令：`{name: "virtual:find-command", args: ["关键词"]}`，例如 `"禁言"`，按名称和描述搜索所有层级。',
    '- 首次使用某条指令前查看详情：`{name: "help", args: ["channel.mute.member"]}`。用详情中的参数和选项键构造调用。',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '指令的完整名称，或用于搜索的 `virtual:find-command`',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: '位置参数列表，按指令定义的顺序传入',
      },
      options: {
        type: 'object',
        description: '选项对象，键名以指令详情为准',
        additionalProperties: true,
      },
      as_uid: {
        type: 'string',
        description: '以谁的身份执行：这一轮说过话的某人的 koishi uid',
      },
    },
    required: ['name'],
  },
}

export interface ExecuteKoishiCommandInput {
  name: string
  args?: string[]
  options?: Record<string, any>
  as_uid?: string
}

/**
 * Commands the agent must not invoke. These are user-facing controls over
 * the agent itself (chat would recurse; llm.* manage memory/sessions/
 * providers and the user — not the AI — should drive them).
 */
const UNAVAILABLE_HERE =
  'This command is not available in this chat. Tell the user it is unavailable here; do not retry or try to work around it.'

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
 */
export function renderAgentHelp(
  catalog: readonly CommandCatalogEntry[],
  queryName?: string
): string {
  const query = queryName?.trim()
  if (!query) {
    if (!catalog.length) return '(暂无可用指令)'
    const lines = catalog.map(
      (e) => `- \`${e.name}\` — ${e.description?.trim() || '(无描述)'}`
    )
    return ['# 可用指令（顶级）', '', ...lines].join('\n')
  }
  const entry = findCatalogEntry(catalog, query)
  if (entry) return renderCatalogEntryDetail(entry)
  return `没有名为「${query}」的指令。可用 \`virtual:find-command\` 按关键词搜索。`
}

function renderCommandSearch(
  catalog: readonly CommandCatalogEntry[],
  keyword?: string
): string {
  const query = keyword?.trim()
  if (!query) return '请在 `args[0]` 提供搜索关键词。'

  const matches = Array.from(
    searchCatalogEntries(catalog, query),
    (e) => `- \`${e.name}\` — ${e.description.trim() || '(无描述)'}`
  )
  if (!matches.length)
    return `没有找到与「${query}」匹配的指令，可换个关键词搜索。`
  return ['# 匹配的指令', '', ...matches, '', '用完整指令名查询详情。'].join(
    '\n'
  )
}

export async function runExecuteKoishiCommand(
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
  if (input.name === 'help' || input.name === 'virtual:find-command') {
    const llm = (ctx as any).llm as
      | { getCatalog?: () => readonly CommandCatalogEntry[] }
      | undefined
    const catalog = llm?.getCatalog?.() ?? []
    return input.name === 'help'
      ? renderAgentHelp(catalog, input.args?.[0])
      : renderCommandSearch(catalog, input.args?.[0])
  }

  // A command whose plugin cannot see this session (installed in a context
  // that leaves it out, e.g. a served-only plugin in an unactivated group)
  // is dropped by Koishi with no output at all. Say so, or the model papers
  // over the silence.
  const command = (session.app as any).$commander?.get(input.name)
  if (command && !command.ctx.filter(session)) return UNAVAILABLE_HERE

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
        // Lets access checks explain a refusal to the model instead of
        // returning nothing, which it would paper over.
        viaAgent: true,
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
  async execute(args, { ctx, session, turnState }) {
    const input = args as ExecuteKoishiCommandInput
    // help and search act on no one.
    if (input?.name === 'help' || input?.name === 'virtual:find-command')
      return runExecuteKoishiCommand(session, input, ctx)
    const speaker = pickSpeaker(turnState, session, input?.as_uid)
    if ('error' in speaker) return speaker.error
    const result = await runExecuteKoishiCommand(speaker.session, input, ctx)
    return `以 ${describeSpeaker(speaker.uid, speaker.session)} 的身份执行了 \`${input.name}\`：\n${result}`
  },
}
