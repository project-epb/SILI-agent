import { Bot, type Context } from '@koishijs/core'

import type { Message, SendOptions, Upload } from '@satorijs/protocol'

import type { QueQiaoMinecraftAdapter } from './adapter'
import {
  createSenderSpeakComponents,
  fromMinecraftTextComponents,
  pruneMessage,
  toMinecraftTextComponents,
} from './message-builder'
import type {
  MinecraftTextComponent,
  MinecraftTextComponentList,
} from './types'

export interface QueQiaoMinecraftBotConfig {
  selfId: string
  serverName: string
  websocket: {
    url: string
    accessToken?: string
    extraHeaders?: Record<string, string>
  }
}

export type Pending = {
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
  timeout: NodeJS.Timeout
}

export class QueQiaoMinecraftBot<C extends Context = Context> extends Bot<
  C,
  QueQiaoMinecraftBotConfig
> {
  ws?: WebSocket
  pending = new Map<string, Pending>()

  constructor(ctx: C, config: QueQiaoMinecraftBotConfig) {
    super(ctx, config, 'minecraft')
    this.selfId = config.selfId
  }

  async sendMessage(
    channelId: string,
    content: any,
    _referrer?: any,
    options?: SendOptions & { raw?: boolean }
  ): Promise<string[]> {
    const adapter = this.adapter as unknown as QueQiaoMinecraftAdapter
    const useRaw = !!options?.raw
    const message = this.normalizeMessageComponents(content, useRaw)
    const components = useRaw
      ? message
      : this.createSenderSpeakComponents(message, {
          username: this.selfId || 'Koishi',
          color: 'light_purple',
        })

    // 约定：channelId 以 mc: 开头则私聊，否则广播
    if (channelId?.startsWith('mc:')) {
      const nickname = channelId.slice(3) || null
      await adapter.sendRequest(this, 'send_private_msg', {
        uuid: null,
        nickname,
        message: components,
      })
      return []
    }

    await adapter.sendRequest(this, 'broadcast', { message: components })
    return []
  }

  async sendPrivateMessage(
    userId: string,
    content: any,
    _guildId?: string,
    options?: SendOptions & { raw?: boolean }
  ): Promise<string[]> {
    const target = userId.startsWith('mc:') ? userId : `mc:${userId}`
    return this.sendMessage(target, content, undefined, options)
  }

  async createMessage(
    channelId: string,
    content: any,
    _referrer?: any,
    options?: SendOptions & { raw?: boolean }
  ): Promise<Message[]> {
    await this.sendMessage(channelId, content, undefined, options)
    return []
  }

  async createUpload(..._uploads: Upload[]): Promise<string[]> {
    return []
  }

  async sendMessageAs(username: string, content: any, groupName?: string) {
    const message = this.normalizeMessageComponents(content, false)
    const components = this.createSenderSpeakComponents(message, {
      username,
      color: 'light_purple',
      hover: groupName ? { text: groupName } : undefined,
    })
    return this.sendMessage('broadcast', components, undefined, { raw: true })
  }

  async rconCommand(command: string): Promise<string> {
    const adapter = this.adapter as unknown as QueQiaoMinecraftAdapter
    return adapter.sendRconCommand(this, command)
  }

  pruneMessage(content: any) {
    return pruneMessage(content)
  }

  toMinecraftTextComponents(content: any) {
    return toMinecraftTextComponents(content)
  }

  fromMinecraftTextComponents(raw: unknown) {
    return fromMinecraftTextComponents(raw)
  }

  createSenderSpeakComponents(
    message: MinecraftTextComponent | MinecraftTextComponentList,
    sender: {
      username: string
      color?: string
      hover?: MinecraftTextComponent | MinecraftTextComponentList
    }
  ) {
    return createSenderSpeakComponents(message, sender)
  }

  private normalizeMessageComponents(content: any, raw: boolean) {
    if (raw) {
      if (Array.isArray(content)) return content as MinecraftTextComponentList
      if (typeof content === 'string') return [content]
      if (content && typeof content === 'object') {
        const maybe = content as MinecraftTextComponent
        const obj = content as Record<string, unknown>
        if (
          'text' in obj ||
          'extra' in obj ||
          'hoverEvent' in obj ||
          'clickEvent' in obj ||
          'color' in obj
        ) {
          return [maybe]
        }
      }
    }

    try {
      return this.toMinecraftTextComponents(content)
    } catch {
      return [{ text: this.pruneMessage(content) }]
    }
  }
}
