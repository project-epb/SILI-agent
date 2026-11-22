import { Context, Service, Session, h } from 'koishi'

import path from 'node:path'

import { resolveConversationScope } from '~/llm/services/conversation-scope'
import { PROTOCOL_TAGS, escapeProtocolTags } from '~/llm/utils/protocol'

import { type Job, LinuxMachine, WORKSPACE } from './machine'
import type { ProxyAddress } from './net-backend'
import { conversationDirName } from './output'
import { buildLinuxTools } from './tools'

declare module 'koishi' {
  interface Context {
    linux: LinuxService
  }
}

export interface Config {
  /** Host directory for the data disk and the distro image cache. */
  dataDir: string
  memoryMiB?: number
  /** HTTP proxy for the guest's egress, e.g. `http://mihomo.sili.local:7897`. */
  proxy?: string
  /** Tool iterations a turn may take where the machine is offered. */
  iterationBudget?: number
}

/** The command whose feature level gates the machine; see FeatureService. */
const COMMAND = 'linux'
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
const ATTACHMENT_TYPES = new Set(['img', 'image', 'file', 'video', 'audio'])

function parseProxy(url?: string): ProxyAddress | undefined {
  if (!url) return undefined
  const u = new URL(url)
  return { host: u.hostname, port: Number(u.port) || 80 }
}

/**
 * One Linux VM for SILI (spec: 2026-11-22-linux-agent-design.md): the exec /
 * file tools, background task notifications and inbound attachments, in the
 * conversations where the `linux` feature is on.
 */
export default class LinuxService extends Service {
  static inject = ['llm', 'feature', 'http']

  readonly machine: LinuxMachine

  constructor(
    ctx: Context,
    options: Config
  ) {
    super(ctx, 'linux')
    const logger = ctx.logger('linux')
    this.machine = new LinuxMachine(
      {
        dataDir: options.dataDir,
        memoryMiB: options.memoryMiB ?? 512,
        proxy: parseProxy(options.proxy),
      },
      logger
    )

    const command = ctx
      .command(`${COMMAND}`, 'SILI 的 Linux 机器', { featLevel: 100, authority: 4 })
      .action(() => {
        const at = this.machine.bootedAt
        return at ? `运行中，启动于 ${at.toLocaleString('sv', { timeZone: 'Asia/Shanghai' })}` : '未启动（用到时自动启动）'
      })
    command.subcommand('.restart', '重启 Linux 机器', { authority: 4 }).action(async () => {
      await this.machine.restart()
      return '重启好了。'
    })

    const tools = buildLinuxTools({
      machine: this.machine,
      available: (session) => this.available(session),
      dirOf: (session) => this.dirOf(session),
      onJobStarted: (session, job, cmd) => this.watchJob(session, job, cmd),
      sendFile: (session, file) => this.sendFile(session, file),
      iterationBudget: options.iterationBudget ?? 40,
    })
    for (const tool of tools) ctx.llm.tools.register(tool)

    ctx.on('dispose', () => {
      for (const tool of tools) ctx.llm.tools.unregister(tool.definition.name)
      this.machine.dispose()
    })
  }

  available(session: Session): boolean {
    const command = this.ctx.$commander.get(COMMAND)
    return !!command && this.ctx.feature.allows(session, command)
  }

  dirOf(session: Session): string {
    return `${WORKSPACE}/${conversationDirName(resolveConversationScope(session).key)}`
  }

  /**
   * Save the message's images and files into the conversation's `inbox/`
   * and say where they went; '' when there are none or the machine is off
   * here.
   */
  async saveAttachments(session: Session): Promise<string> {
    if (!this.available(session)) return ''
    const elements = h
      .select(session.elements ?? [], [...ATTACHMENT_TYPES].join(','))
      .filter((el) => el.attrs.src || el.attrs.url)
    if (!elements.length) return ''
    const inbox = `${this.dirOf(session)}/inbox`
    const lines: string[] = []
    for (const [i, el] of elements.entries()) {
      const src = String(el.attrs.src || el.attrs.url)
      const file = await this.ctx.http.file(src)
      const bytes = new Uint8Array(file.data)
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        lines.push(`<skipped type="${el.type}" reason="over ${MAX_ATTACHMENT_BYTES} bytes"/>`)
        continue
      }
      const name = safeName(String(el.attrs.filename || el.attrs.title || file.filename || ''), el.type, file.type, i)
      const target = `${inbox}/${Date.now().toString(36)}-${name}`
      const error = await this.machine.writeFile(target, bytes)
      lines.push(
        error
          ? `<skipped type="${el.type}" reason="${escapeAttr(error)}"/>`
          : `<file path="${escapeAttr(target)}" type="${escapeAttr(file.type || el.type)}" size="${bytes.length}"/>`
      )
    }
    return [PROTOCOL_TAGS.ATTACHMENTS.open, ...lines, PROTOCOL_TAGS.ATTACHMENTS.close].join('\n')
  }

  private watchJob(session: Session, job: Job, command: string) {
    void job.done.then((result) => {
      const info = {
        task_id: job.id,
        command: command.length > 300 ? `${command.slice(0, 300)}…` : command,
        exit_code: result.exitCode,
        duration_s: Math.round(result.durationMs / 1000),
        log_path: job.logPath,
      }
      const envelope = [
        PROTOCOL_TAGS.TASK_NOTIFICATION.open,
        JSON.stringify(info),
        result.exitCode === null ? '任务被杀掉了，或者机器重启了，没有拿到退出码。' : '',
        '日志末尾：',
        escapeProtocolTags(result.logTail),
        PROTOCOL_TAGS.TASK_NOTIFICATION.close,
      ]
        .filter(Boolean)
        .join('\n')
      this.notify(session, envelope)
    })
  }

  /**
   * Deliver a system message to the conversation: steered into the running
   * turn, or as a turn of its own (no prompt; see chat.tsx) when idle.
   */
  private notify(session: Session, envelope: string) {
    const llm = this.ctx.llm
    const key = resolveConversationScope(session).key
    const item = { session, prompt: '', envelope }
    const running = llm.activeChats.get(key)
    if (running) {
      running.inbox.push(item)
      return
    }
    llm.activeChats.putBacklog(key, [item])
    session
      .execute({ name: 'chat', args: [''] })
      .catch((e) => this.ctx.logger('linux').warn('notification turn failed:', e))
  }

  private async sendFile(
    session: Session,
    file: { name: string; bytes: Uint8Array; mime?: string; caption?: string }
  ) {
    const buffer = Buffer.from(file.bytes)
    const element = file.mime
      ? h.image(buffer, file.mime)
      : h('file', {
          src: `data:application/octet-stream;base64,${buffer.toString('base64')}`,
          filename: file.name,
        })
    if (file.caption) await session.send(file.caption)
    const ids = await session.send(element)
    if (!ids.length) throw new Error('the platform accepted nothing')
  }
}

function escapeAttr(s: string) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

const EXT_OF_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

function safeName(raw: string, type: string, mime: string, index: number): string {
  const base = path.posix.basename(raw).replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^\.+/, '')
  if (base && base !== 'file') return base.slice(0, 100)
  const ext = EXT_OF_MIME[mime] ?? (type === 'img' || type === 'image' ? 'png' : 'bin')
  return `${type}-${index + 1}.${ext}`
}
