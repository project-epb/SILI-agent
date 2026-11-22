import type { Session } from 'koishi'

import path from 'node:path'

import type { ToolDefinition } from '~/llm/providers/_base'
import type { ToolHandler } from '~/llm/tools/types'

import { type Job, type LinuxMachine, MachineDownError, WORKSPACE, decode } from './machine'
import { clipStream } from './output'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 10 * 60_000
const MAX_TEXT_READ_BYTES = 1024 * 1024
const MAX_SEND_BYTES = 20 * 1024 * 1024
const DEFAULT_READ_LINES = 500
const BINARY_SNIFF_BYTES = 8192

const IMAGE_MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

export interface LinuxToolDeps {
  machine: LinuxMachine
  available(session: Session): boolean
  /** The conversation's own directory under /workspace. */
  dirOf(session: Session): string
  /** A background job started in this session; report it when it ends. */
  onJobStarted(session: Session, job: Job, command: string): void
  sendFile(session: Session, file: { name: string; bytes: Uint8Array; mime?: string; caption?: string }): Promise<void>
  iterationBudget: number
}

const EXEC_TOOL: ToolDefinition = {
  name: 'exec',
  description: [
    '在你自己的 Linux 机器上执行 shell 命令。',
    '',
    '**机器**：Alpine Linux（aarch64），你以 `user` 身份执行，可免密 `sudo`。已装 bash、python3、pip、curl、jq、git、ripgrep；缺什么就 `sudo apk add` 装，Python 包用 `pip install --user --break-system-packages`。能上公网，内网地址一律不通。',
    '**机器是持久的**：装的包、HOME（`/home/user`）和 `/workspace` 下的文件重启后都在。HOME 在所有会话间共享；每个会话有自己的目录，这一轮的默认目录就是它。',
    '**目录**：每次调用都从 `cwd`（不传就是会话目录）开始，`cd` 只在这一次调用里有效。',
    '**输出**：stdout 与 stderr 各保留开头 4 KiB 和结尾 16 KiB；被截断时完整输出存在结果里给出的文件里。前台命令到 `timeout_ms` 会被杀掉。',
    '**长任务**（安装大依赖、编译、爬取、起服务）设 `background: true`：立刻返回任务 id 和日志路径，结束后会以 <task_notification> 告诉你结果。不要轮询等待，继续做别的事或先回复用户。通知是系统消息，不是用户说话：正在干活时收到，就当进度更新并进当前工作，不用专门回应；空闲时收到，告诉用户结果即可。要提前结束就 `kill <pid>`。',
    '**用户看不到这台机器**：结果要你自己转述；要把文件给用户，用 send_file。创建和修改文件用 write_file、edit_file，不要用 heredoc 或 sed。',
    '**何时用**：计算、数据处理、文件转换、运行和测试代码、需要装工具才能做的事。能直接回答的问题不要用。',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '由 sh -c 执行的命令' },
      cwd: { type: 'string', description: '起始目录，默认会话目录；相对路径按会话目录解析' },
      timeout_ms: {
        type: 'integer',
        description: `前台超时，默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}`,
        minimum: 1000,
        maximum: MAX_TIMEOUT_MS,
      },
      background: { type: 'boolean', description: '作为后台任务运行，结束后通知你' },
    },
    required: ['command'],
    additionalProperties: false,
  },
}

const READ_FILE_TOOL: ToolDefinition = {
  name: 'read_file',
  description:
    '读取 Linux 机器上的文本文件，每行前带行号。大文件用 offset（起始行，从 1 开始）和 limit（行数）分段读。二进制文件读不了，用 exec 处理或 send_file 发给用户。相对路径按会话目录解析。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      offset: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, description: `默认 ${DEFAULT_READ_LINES}` },
    },
    required: ['path'],
    additionalProperties: false,
  },
}

const WRITE_FILE_TOOL: ToolDefinition = {
  name: 'write_file',
  description:
    '在 Linux 机器上创建文件，或整个覆盖已有文件。会自动创建上级目录。被覆盖的内容不会保留。相对路径按会话目录解析。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string', description: '文件的完整内容（UTF-8 文本）' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
}

const EDIT_FILE_TOOL: ToolDefinition = {
  name: 'edit_file',
  description:
    '替换 Linux 机器上某个文件里的一段文字。old_text 按字面匹配（不是正则），必须与文件内容完全一致，包括缩进，且不带 read_file 显示的行号。它必须在文件里只出现一次，所以要带上足够的上下文；要替换所有出现处就传 replace_all。new_text 为空表示删除。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_text: { type: 'string' },
      new_text: { type: 'string' },
      replace_all: { type: 'boolean' },
    },
    required: ['path', 'old_text', 'new_text'],
    additionalProperties: false,
  },
}

const SEND_FILE_TOOL: ToolDefinition = {
  name: 'send_file',
  description: `把 Linux 机器上的文件发到当前聊天。图片（png/jpg/gif/webp）以图片发出，其他以文件发出，上限 ${MAX_SEND_BYTES / 1024 / 1024} MiB。相对路径按会话目录解析。`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      caption: { type: 'string', description: '随文件一起发的一句话，可省略' },
    },
    required: ['path'],
    additionalProperties: false,
  },
}

function down(e: unknown): string {
  if (e instanceof MachineDownError)
    return `Error: the machine is down (${e.message}). The next call boots it again; files on disk are kept.`
  throw e
}

export function buildLinuxTools(deps: LinuxToolDeps): ToolHandler[] {
  const { machine } = deps
  const ready = new Set<string>()
  const dirFor = async (session: Session) => {
    const dir = deps.dirOf(session)
    if (!ready.has(dir)) {
      await machine.mkdir(dir)
      ready.add(dir)
    }
    return dir
  }
  const resolveIn = (dir: string, p?: string) => (p ? path.posix.resolve(dir, p) : dir)
  const gate = { available: deps.available, iterationBudget: deps.iterationBudget }

  const exec: ToolHandler = {
    ...gate,
    definition: EXEC_TOOL,
    async execute(args, { session, signal }) {
      try {
        const dir = await dirFor(session)
        const cwd = resolveIn(dir, args.cwd)
        if (args.background) {
          const job = await machine.startJob(args.command, cwd)
          deps.onJobStarted(session, job, args.command)
          return `Started ${job.id} (pid ${job.pid}). Output goes to ${job.logPath}. You will get a <task_notification> when it ends; do not wait for it.`
        }
        const timeoutMs = Math.min(Math.max(args.timeout_ms ?? DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS)
        const started = Date.now()
        const r = await machine.shell(args.command, cwd, { timeoutMs, signal })
        const seconds = ((Date.now() - started) / 1000).toFixed(1)
        if (r.aborted) return 'The user stopped this command; it was killed.'
        if (r.timedOut)
          return `Timed out after ${timeoutMs / 1000}s and was killed. Run long commands with background: true.`
        const out = clipStream(r.stdout)
        const err = clipStream(r.stderr)
        const parts = [`exit_code: ${r.exitCode ?? `signal ${r.signal}`} (${seconds}s)`]
        if (out.text) parts.push('### stdout', out.text.replace(/\n$/, ''))
        if (err.text) parts.push('### stderr', err.text.replace(/\n$/, ''))
        if (!out.text && !err.text) parts.push('(no output)')
        if (out.omitted || err.omitted) {
          const full = `/tmp/sili-exec/${Date.now().toString(36)}`
          await machine.writeFile(`${full}.stdout`, r.stdout)
          await machine.writeFile(`${full}.stderr`, r.stderr)
          parts.push(`Full output: ${full}.stdout and ${full}.stderr`)
        }
        if (r.finalCwd && r.finalCwd !== cwd)
          parts.push(
            `Note: this command ended in ${r.finalCwd}, but a cd lasts only for its own call: the next call starts in ${dir} again unless you pass cwd.`
          )
        return parts.join('\n')
      } catch (e) {
        return down(e)
      }
    },
  }

  const readFile: ToolHandler = {
    ...gate,
    definition: READ_FILE_TOOL,
    async execute(args, { session }) {
      try {
        const file = resolveIn(await dirFor(session), args.path)
        const data = await machine.readFile(file, MAX_TEXT_READ_BYTES)
        if (typeof data === 'string') return `Error: ${data}`
        if (data.subarray(0, BINARY_SNIFF_BYTES).includes(0))
          return `Error: ${file} is a binary file (${data.length} bytes). Inspect it with exec, or send it with send_file.`
        const lines = decode(data).split('\n')
        if (lines.at(-1) === '') lines.pop()
        const start = (args.offset ?? 1) - 1
        const slice = lines.slice(start, start + (args.limit ?? DEFAULT_READ_LINES))
        if (!slice.length) return `(${file} has ${lines.length} lines; nothing from line ${start + 1})`
        const width = String(start + slice.length).length
        const body = slice.map((l, i) => `${String(start + i + 1).padStart(width)}\t${l}`).join('\n')
        const end = start + slice.length
        return end < lines.length || start > 0
          ? `${body}\n(lines ${start + 1}-${end} of ${lines.length})`
          : body
      } catch (e) {
        return down(e)
      }
    },
  }

  const writeFile: ToolHandler = {
    ...gate,
    definition: WRITE_FILE_TOOL,
    async execute(args, { session }) {
      try {
        const file = resolveIn(await dirFor(session), args.path)
        const error = await machine.writeFile(file, String(args.content ?? ''))
        return error ? `Error: ${error}` : `Wrote ${file}`
      } catch (e) {
        return down(e)
      }
    },
  }

  const editFile: ToolHandler = {
    ...gate,
    definition: EDIT_FILE_TOOL,
    async execute(args, { session }) {
      try {
        const file = resolveIn(await dirFor(session), args.path)
        const data = await machine.readFile(file, MAX_TEXT_READ_BYTES)
        if (typeof data === 'string') return `Error: ${data}`
        const text = decode(data)
        const oldText = String(args.old_text ?? '')
        if (!oldText) return 'Error: old_text is empty.'
        const count = text.split(oldText).length - 1
        if (count === 0) return `Error: old_text was not found in ${file}.`
        if (count > 1 && !args.replace_all)
          return `Error: old_text matches ${count} places in ${file}. Add surrounding lines to make it unique, or pass replace_all.`
        const next = args.replace_all
          ? text.split(oldText).join(String(args.new_text ?? ''))
          : text.replace(oldText, () => String(args.new_text ?? ''))
        const error = await machine.writeFile(file, next)
        return error ? `Error: ${error}` : `Edited ${file} (${args.replace_all ? count : 1} replacement${count > 1 && args.replace_all ? 's' : ''})`
      } catch (e) {
        return down(e)
      }
    },
  }

  const sendFile: ToolHandler = {
    ...gate,
    definition: SEND_FILE_TOOL,
    async execute(args, { session }) {
      try {
        const file = resolveIn(await dirFor(session), args.path)
        const data = await machine.readFile(file, MAX_SEND_BYTES)
        if (typeof data === 'string') return `Error: ${data}`
        const name = path.posix.basename(file)
        const ext = name.split('.').pop()?.toLowerCase() ?? ''
        await deps.sendFile(session, { name, bytes: data, mime: IMAGE_MIMES[ext], caption: args.caption })
        return `Sent ${name} (${data.length} bytes) to the chat.`
      } catch (e) {
        if (e instanceof MachineDownError) return down(e)
        return `Error: sending failed: ${e instanceof Error ? e.message : e}`
      }
    },
  }

  return [exec, readFile, writeFile, editFile, sendFile]
}

export { WORKSPACE }
