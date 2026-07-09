/**
 * @name FallbackHandler
 * @desc 内部插件，用于处理未匹配到任何指令的消息
 */
import { Context, sleep } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

declare module 'koishi' {
  interface Session {
    /**
     * 项目内部约定：凡是通过 `session.send` 而非返回 Fragment 来回应消息的
     * 中间件，都应该把这个字段置为 `true`，让 {@link FallbackHandler}
     * 知道这条消息已经有人接手。
     *
     * 单看 `session.argv.command` 不够 —— koishi 只在自带 command 派发器
     * 接走消息时才设置它；自研中间件（例如 mediawiki / pixiv 的链接展开、
     * repeater 等）自己响应时不会标记。
     */
    _handled?: boolean
  }
}

export interface Config {
  /** 总开关；false 时本插件什么都不挂载，等同于不加载。默认 true */
  enabled?: boolean
  /** 命中兜底时是否打日志。默认 true */
  enableLog?: boolean
  /** @bot 无内容时是否调 ping。默认 true */
  enablePing?: boolean
  /** @bot 有内容但没人接时是否调 chat。默认 true */
  enableChat?: boolean
  /** 发送 ping/chat 前的延迟（ms），防止微妙的竞态。默认 500 */
  delayMs?: number
}

type ResolvedConfig = Required<Config>

const DEFAULTS: ResolvedConfig = {
  enabled: true,
  enableLog: true,
  enablePing: true,
  enableChat: true,
  delayMs: 500,
}

export default class FallbackHandler extends BasePlugin<ResolvedConfig> {
  constructor(
    public ctx: Context,
    userConfig: Config = {}
  ) {
    const config: ResolvedConfig = { ...DEFAULTS, ...userConfig }
    super(ctx, config, 'FallbackHandler')

    if (!config.enabled) return

    // 框架层双保险：command/before-execute 和 satori 的 before-send 事件
    // 都不受 instance property 被 delete 的影响，比单纯 patch session 方法
    // 更稳。dialogue 的 MessageBuffer 在 end() 时会 `delete session.send`，
    // 会把本插件挂上去的 instance patch 也一并清掉；而事件 hook 不会丢。
    ctx.before('command/execute', (argv) => {
      if (argv.session) argv.session._handled = true
    })
    ctx.before('send', (session) => {
      session._handled = true
    })

    // 用 `prepend = true` 把这条 middleware 钉在队首：pre-next 最先进入，
    // 但在 koishi 洋葱模型下，post-next 反而是 *最后* 才跑 —— 这才是真正
    // 「所有人（包括 pixiv / mediawiki / who-asked 这类后置响应中间件）
    // 都有机会处理过这条消息」的时刻。
    //
    // 重要：必须把下游返回的 Fragment 透传出去。koishi 自带的 attach
    // middleware 在 shortcut 命中时会直接 return 一个 Fragment（参见
    // @koishijs/core middleware.ts attach()），这个 Fragment 要冒泡到
    // `_handleMessage` 外层才会被发送。一旦在这里吞掉，所有 prefix-shortcut
    // 形式的命令（例如 llm/chat 的 `?` shortcut）都会静默失效。
    ctx.middleware(async (session, next) => {
      const _sessionExecute: typeof session.execute =
        session.execute.bind(session)
      session.execute = async (...args) => {
        session._handled = true
        return _sessionExecute(...args)
      }
      const _sessionSend: typeof session.send = session.send.bind(session)
      session.send = async (...args) => {
        session._handled = true
        return _sessionSend(...args)
      }

      const result = await next()

      if (result) return result
      if (!session.stripped.atSelf && !session.stripped.appel) return result
      if (session.argv?.command || session._handled) return result

      if (config.delayMs > 0) await sleep(config.delayMs)
      if (session._handled) return result

      if (config.enableLog) {
        this.logger.info(
          'addressed to bot but no handler matched:',
          session.stripped.content
        )
      }

      const cleanContent = session.stripped.content.trim()
      if (!cleanContent) {
        // 仅有 @ 提及但无其他内容，视为用户想要唤醒/测试机器人
        if (config.enablePing) {
          return _sessionExecute({ name: 'ping' })
        }
      } else {
        // 有其他内容但未被任何指令/中间件处理，视为用户想要聊天
        if (config.enableChat) {
          return _sessionExecute({ name: 'chat', args: [cleanContent] })
        }
      }
      return result
    }, true)
  }
}
