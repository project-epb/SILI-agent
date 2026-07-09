import {
  Adapter,
  type Context,
  Logger,
  Schema,
  type Session,
} from '@koishijs/core'

import {
  type Pending,
  QueQiaoMinecraftBot,
  type QueQiaoMinecraftBotConfig,
} from './bot'
import type {
  QueQiaoApi,
  QueQiaoEvent,
  QueQiaoRequest,
  QueQiaoResponse,
} from './types'

export interface QueQiaoMinecraftAdapterConfig {
  bots: QueQiaoMinecraftBotConfig[]
  debug?: boolean
  reconnectInterval?: number
  maxReconnectAttempts?: number
  requestTimeout?: number
}

class QueQiaoMinecraftWsClient<C extends Context> extends Adapter.WsClientBase<
  C,
  QueQiaoMinecraftBot<C>
> {
  constructor(
    ctx: C,
    private owner: QueQiaoMinecraftAdapter<C>,
    private bot: QueQiaoMinecraftBot<C>,
    config: Adapter.WsClientConfig
  ) {
    super(ctx, config)
  }

  protected prepare() {
    const wsConfig = this.bot.config.websocket
    const headers: Record<string, string> = {
      'x-self-name': this.bot.config.serverName,
      ...(wsConfig.extraHeaders || {}),
    }
    if (wsConfig.accessToken) {
      headers['Authorization'] = `Bearer ${wsConfig.accessToken}`
    }

    this.owner.logDebug(`Connecting bot=${this.bot.selfId} url=${wsConfig.url}`)
    this.owner.logDebug('Headers:', headers)
    return this.ctx.http.ws(wsConfig.url, { headers })
  }

  protected accept(socket: WebSocket) {
    this.bot.ws = socket

    // QueQiao 无显式 READY，连接建立即认为上线
    this.bot.online()
    this.owner.logger.info(`QueQiao WebSocket connected (${this.bot.selfId})`)

    socket.addEventListener('message', (ev) => {
      const { data } = ev
      try {
        const text = typeof data === 'string' ? data : data.toString()
        this.owner.logDebug(`WS recv (${this.bot.selfId}):`, text)
        const obj = JSON.parse(text)
        this.owner.handleIncoming(this.bot, obj)
      } catch (err) {
        this.owner.logger.warn(
          `Failed to parse WS message (${this.bot.selfId})`,
          err
        )
      }
    })
  }

  protected getActive() {
    return this.bot.isActive
  }

  protected setStatus(status: any, error?: Error) {
    // Status 来自 @satorijs/protocol，这里不强依赖枚举类型
    ;(this.bot as any).status = status
    ;(this.bot as any).error = error
  }
}

export class QueQiaoMinecraftAdapter<
  C extends Context = Context,
> extends Adapter<C, QueQiaoMinecraftBot<C>> {
  public logger = new Logger('adapter-minecraft-queqiao')
  private debug: boolean
  private requestTimeout: number
  private wsClientConfig: Adapter.WsClientConfig
  private clients = new Map<string, QueQiaoMinecraftWsClient<C>>()

  constructor(
    ctx: C,
    private config: QueQiaoMinecraftAdapterConfig
  ) {
    super(ctx)

    this.debug = !!config.debug
    const retryInterval = config.reconnectInterval ?? 5000
    const retryTimes = config.maxReconnectAttempts ?? 10
    // 为了保持旧行为：始终按同一间隔重试
    this.wsClientConfig = {
      retryInterval,
      retryTimes,
      retryLazy: retryInterval,
    }
    this.requestTimeout = config.requestTimeout ?? 10_000

    ctx.on('ready', async () => {
      for (const botConfig of config.bots) {
        const bot = new QueQiaoMinecraftBot(ctx, botConfig)
        bot.adapter = this
        this.bots.push(bot)
        await this.connect(bot)
      }
    })
  }

  logDebug(...args: any[]) {
    if (!this.debug) return
    this.logger.info('[DEBUG]', ...args)
  }

  async connect(bot: QueQiaoMinecraftBot<C>) {
    if (this.clients.has(bot.selfId)) return
    const client = new QueQiaoMinecraftWsClient(
      this.ctx,
      this,
      bot,
      this.wsClientConfig
    )
    this.clients.set(bot.selfId, client)
    await client.start()
  }

  async disconnect(bot: QueQiaoMinecraftBot<C>) {
    const client = this.clients.get(bot.selfId)
    if (!client) return
    await client.stop()
    this.clients.delete(bot.selfId)
  }

  handleIncoming(bot: QueQiaoMinecraftBot, obj: any) {
    // response
    if (obj && obj.post_type === 'response') {
      const echo = obj.echo
      if (echo && bot.pending.has(echo)) {
        const pending = bot.pending.get(echo)!
        clearTimeout(pending.timeout)
        bot.pending.delete(echo)
        pending.resolve(obj)
      }
      return
    }

    // event
    const event = obj as QueQiaoEvent
    const session = this.createSession(bot, event)
    if (session) bot.dispatch(session)
  }

  private createSession(
    bot: QueQiaoMinecraftBot,
    payload: QueQiaoEvent
  ): Session | undefined {
    const postType = (payload as any)?.post_type
    const subType = (payload as any)?.sub_type
    const eventName = (payload as any)?.event_name

    let kind: 'chat' | 'join' | 'quit' | undefined

    if (
      postType === 'message' &&
      (subType === 'player_chat' || eventName === 'PlayerChatEvent')
    ) {
      kind = 'chat'
    } else if (
      postType === 'notice' &&
      (subType === 'player_join' || eventName === 'PlayerJoinEvent')
    ) {
      kind = 'join'
    } else if (
      postType === 'notice' &&
      (subType === 'player_quit' || eventName === 'PlayerQuitEvent')
    ) {
      kind = 'quit'
    }

    if (!kind) return

    const tsSeconds = Number((payload as any)?.timestamp || Date.now() / 1000)
    const timestamp = Math.floor(tsSeconds * 1000)
    const serverName =
      (payload as any)?.server_name || bot.config.serverName || 'minecraft'

    const player = (payload as any)?.player || {}
    const userId = player.uuid || player.nickname || 'unknown'
    const username = player.nickname || userId

    const baseEvent: any = {
      sn: Date.now(),
      platform: 'minecraft',
      selfId: bot.selfId,
      timestamp,
      user: { id: userId, name: username },
      channel: { id: serverName, type: 0 },
      guild: { id: serverName, name: serverName },
      referrer: payload,
    }

    if (kind === 'chat') {
      const rawCandidate =
        (payload as any)?.message != null
          ? (payload as any)?.message
          : (payload as any)?.raw_message

      const tryParseMaybeJson = (value: unknown): unknown => {
        if (typeof value !== 'string') return value
        const trimmed = value.trim()
        if (!trimmed) return value
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
        try {
          return JSON.parse(trimmed)
        } catch {
          return value
        }
      }

      let content: any
      const parsed = tryParseMaybeJson(rawCandidate)
      if (parsed && (typeof parsed === 'object' || Array.isArray(parsed))) {
        try {
          content = bot.fromMinecraftTextComponents(parsed)
        } catch {
          content = this.extractText(parsed)
        }
      } else {
        content = this.extractText(rawCandidate)
      }

      const text = String(content ?? '')

      baseEvent.type = 'message'
      baseEvent.message = {
        id: String((payload as any)?.message_id || Date.now()),
        content: text,
        user: baseEvent.user,
        createdAt: timestamp,
        updatedAt: timestamp,
      }

      const session = bot.session(baseEvent)
      session.content = text
      return session
    }

    if (kind === 'join') {
      baseEvent.type = 'guild-member-added'
      baseEvent.member = { user: baseEvent.user, joinedAt: timestamp }
      return bot.session(baseEvent)
    }

    if (kind === 'quit') {
      baseEvent.type = 'guild-member-removed'
      baseEvent.member = { user: baseEvent.user }
      return bot.session(baseEvent)
    }

    return
  }

  private extractText(message: unknown): string {
    if (message == null) return ''
    if (typeof message === 'string') {
      const s = message
      const trimmed = s.trim()

      // 某些实现会把 TextComponent/RawText 作为 JSON 字符串返回，例如：{"text":"!help"}
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed)
          return this.extractText(parsed)
        } catch {
          // ignore
        }
      }

      return s
    }
    if (typeof message === 'number' || typeof message === 'boolean') {
      return String(message)
    }

    if (Array.isArray(message)) {
      return message.map((m) => this.extractText(m)).join('')
    }

    if (typeof message === 'object') {
      const obj: any = message

      // Minecraft RawText / TextComponent 常见字段：text + extra
      let acc = ''
      if (typeof obj.text === 'string') acc += obj.text
      else if (typeof obj.content === 'string') acc += obj.content

      // 兼容 translate/with（尽量提取参数文本，不做本地化翻译）
      if (!acc && typeof obj.translate === 'string' && obj.with) {
        acc += this.extractText(obj.with)
      }

      if (obj.extra) acc += this.extractText(obj.extra)
      return acc
    }

    return String(message)
  }

  async sendRequest<TData, TResp>(
    bot: QueQiaoMinecraftBot,
    api: QueQiaoApi,
    data: TData
  ): Promise<QueQiaoResponse<TResp>> {
    if (!bot.ws || bot.ws.readyState !== WebSocket.OPEN) {
      throw new Error('QueQiao WebSocket not connected')
    }

    const echo = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const req: QueQiaoRequest<TData> = { api, data, echo }

    const p = new Promise<QueQiaoResponse<TResp>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        bot.pending.delete(echo)
        reject(new Error(`QueQiao request timeout: ${api}`))
      }, this.requestTimeout)

      bot.pending.set(echo, { resolve, reject, timeout } satisfies Pending)
    })

    this.logDebug(`WS send (${bot.selfId}):`, req)
    bot.ws.send(JSON.stringify(req))

    const resp = await p
    return resp
  }

  async sendRconCommand(
    bot: QueQiaoMinecraftBot,
    command: string
  ): Promise<string> {
    const resp = await this.sendRequest<{ command: string }, string>(
      bot,
      'send_rcon_command',
      { command }
    )

    if (resp.status !== 'SUCCESS') {
      throw new Error(`RCON failed: ${resp.message || resp.status}`)
    }

    return String(resp.data ?? '')
  }

  async stop() {
    for (const bot of this.bots) {
      try {
        await this.disconnect(bot)
      } catch {
        // ignore
      }
      for (const pending of bot.pending.values()) {
        clearTimeout(pending.timeout)
        pending.reject(new Error('Adapter stopped'))
      }
      bot.pending.clear()
    }
  }
}

export namespace QueQiaoMinecraftAdapter {
  export const Config: Schema<QueQiaoMinecraftAdapterConfig> = Schema.object({
    debug: Schema.boolean().default(false),
    reconnectInterval: Schema.number().default(5000),
    maxReconnectAttempts: Schema.number().default(10),
    requestTimeout: Schema.number().default(10_000),
    bots: Schema.array(
      Schema.object({
        selfId: Schema.string().required(),
        serverName: Schema.string().required(),
        websocket: Schema.object({
          url: Schema.string().required(),
          accessToken: Schema.string(),
          extraHeaders: Schema.dict(Schema.string()),
        }).required(),
      })
    ).default([]),
  })
}

export default QueQiaoMinecraftAdapter
