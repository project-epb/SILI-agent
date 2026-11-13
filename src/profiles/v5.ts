/**
 * v5 profile: the official QQ bot replaces OneBot; every other adapter keeps
 * serving. Plugins come back in phases, see
 * docs/superpowers/specs/2026-11-13-sili-profiles-design.md. This is phase 1.
 *
 * Access control (unactivated groups and DMs are not served) is not in yet.
 * Until it is, never run v5 against a bot that is public, and do not load the
 * OneBot adapter here: without the guards it would serve every message.
 */
import { App, Context } from 'koishi'

import process from 'node:process'

import AdapterMinecraft from '@/adapters/queqiao-minecraft'
import { logProcessErrors } from '@/bootstrap'
import FallbackHandler from '@/modules/FallbackHandler'
import SilentSwitch from '@/modules/SilentSwitch'
import {
  assetsS3Config,
  consoleConfig,
  gelbooruConfig,
  githubConfig,
  llmConfig,
  puppeteerConfig,
} from '@/profiles/shared/plugin-configs'
import type { Profile } from '@/profiles/types'
import PiggybackService from '@/services/PiggybackService'
import HTMLService from '@/services/html'

import PluginAbout from '~/about'
import PatchCallme from '~/callme'
import PluginDatabaseAdmin from '~/dbadmin'
import PluginDice from '~/dice'
import PluginGelbooru from '~/gelbooru'
import PluginGithub from '~/github'
import PluginHljs from '~/hljs'
import { PluginHomo } from '~/homo'
import PluginLLM from '~/llm'
import PluginMarkdown from '~/md'
import PluginPing from '~/ping'
import PluginProfile from '~/profile'
import PluginQueue from '~/queue'
import PluginReboot from '~/reboot'
import PluginSensitiveFilter from '~/sensitive-words-filter'
import PluginSpawn from '~/spawn'
import PluginSticker from '~/sticker'
import PluginToImage from '~/to-image'
import PluginWebShot from '~/webshot'

import AdapterDingtalk from '@koishijs/plugin-adapter-dingtalk'
import AdapterDiscord from '@koishijs/plugin-adapter-discord'
import AdapterKook from '@koishijs/plugin-adapter-kook'
import AdapterLark from '@koishijs/plugin-adapter-lark'
import * as PluginAdmin from '@koishijs/plugin-admin'
import PluginAuth from '@koishijs/plugin-auth'
import * as PluginBind from '@koishijs/plugin-bind'
import * as PluginCallme from '@koishijs/plugin-callme'
import PluginCommands from '@koishijs/plugin-commands'
import PluginConsole from '@koishijs/plugin-console'
import * as PluginEcho from '@koishijs/plugin-echo'
import * as PluginHelp from '@koishijs/plugin-help'
import * as PluginLogger from '@koishijs/plugin-logger'
import * as PluginStatus from '@koishijs/plugin-status'

import AdapterQQ from 'koishi-plugin-adapter-qq-crack'
import PluginAssetsS3 from 'koishi-plugin-assets-s3'
import * as PluginLlmAdmin from 'koishi-plugin-llm-admin'
import * as PluginLlmDashboard from 'koishi-plugin-llm-dashboard'
import PluginPuppeteer from 'koishi-plugin-puppeteer'
import * as PluginRateLimit from 'koishi-plugin-rate-limit'
import * as PluginRecall from 'koishi-plugin-recall'
import PluginSilk from 'koishi-plugin-silk'
import * as PluginSwitch from 'koishi-plugin-switch'

import PluginHTTP from '@cordisjs/plugin-http'

const { env } = process

function appOptions(env: NodeJS.ProcessEnv): Partial<Context.Config> {
  return {
    prefix: (session) => {
      // 官方 QQ：没有 @ 时用 slash
      if (['qq', 'qqguild'].includes(session.platform)) {
        return '/'
      }
      // 钉钉适配器，必须 at 才能收到消息，无需前缀
      if (session.platform === 'dingtalk') {
        return ''
      }
      const prefixes = env.KOISHI_PREFIX?.split('|') || []
      if (session.platform === 'discord') {
        prefixes.unshift('/')
      }
      return prefixes
    },
  }
}

function install(app: App) {
  logProcessErrors(app)

  /** 安装适配器 */
  app.plugin(function PluginCollectionAdapters(ctx) {
    // 官方 QQ bot。使用适配器默认的 intents（含入群申请等群事件需要的 GROUP_MEMBER_EVENT）。
    if (env.QQBOT_APPID) {
      ctx.plugin(AdapterQQ, {
        id: env.QQBOT_APPID,
        secret: env.QQBOT_APPSECRET,
        type: env.QQBOT_TYPE,
      })
    }

    if (env.TOKEN_DISCORD_BOT) {
      ctx.plugin(AdapterDiscord, {
        token: env.TOKEN_DISCORD_BOT,
      })
    }

    const DINGTALK_AGENTID = env.DINGTALK_AGENTID
    const DINGTALK_APPKEY = env.DINGTALK_APPKEY
    const DINGTALK_SECRET = env.DINGTALK_SECRET
    if (DINGTALK_AGENTID && DINGTALK_APPKEY && DINGTALK_SECRET) {
      ctx.plugin(AdapterDingtalk, {
        protocol: 'ws',
        agentId: +DINGTALK_AGENTID,
        appkey: DINGTALK_APPKEY,
        secret: DINGTALK_SECRET,
      })
      // AdapterDingtalk 没有正确应答，钉钉会重复推送同一条消息，只能在这里按 messageId 去重
      const handledMsgIds: string[] = []
      ctx.on('message', (session) => {
        if (session.platform !== 'dingtalk') return
        const eventId = session.messageId
        if (handledMsgIds.includes(eventId)) {
          ctx
            .logger('DINGTALK')
            .debug(`Ignore duplicated event ${eventId} from DingTalk`)
          return ''
        }
        handledMsgIds.push(eventId)
        if (handledMsgIds.length > 100) {
          handledMsgIds.splice(0, handledMsgIds.length - 100)
        }
      })
    }

    if (env.KOOK_TOKEN) {
      ctx.plugin(AdapterKook, {
        protocol: 'ws',
        token: env.KOOK_TOKEN,
      })
    }

    // Minecraft 与 QQ 群互通（MinecraftConnect）依赖 OneBot，属于阶段三，这里只装适配器
    if (env.MINECRAFT_SERVER_NAME && env.MINECRAFT_SERVER_URL) {
      ctx.plugin(AdapterMinecraft, {
        bots: [
          {
            selfId: 'SILI',
            serverName: env.MINECRAFT_SERVER_NAME || 'QueQiao',
            websocket: {
              url: env.MINECRAFT_SERVER_URL,
              accessToken: env.MINECRAFT_SERVER_TOKEN || undefined,
            },
          },
        ],
        debug: env.MINECRAFT_DEBUG === '1',
      })
    }

    if (env.FEISHU_APPID && env.FEISHU_APPSECRET) {
      ctx.plugin(AdapterLark, {
        appId: env.FEISHU_APPID,
        appSecret: env.FEISHU_APPSECRET,
        encryptKey: env.FEISHU_ENCRYPT_KEY,
        verificationToken: env.FEISHU_VERIFICATION_TOKEN,
        protocol: 'ws',
      })
    }
  })

  // 核心与通用
  app.plugin(function PluginCollectionCore(ctx) {
    ctx.plugin(PluginHelp)
    ctx.plugin(PluginCommands)
    ctx.plugin(PluginSwitch)
    ctx.plugin(PluginAssetsS3, assetsS3Config(env))
    ctx.plugin(PluginHTTP)
    // HTMLService 依赖 puppeteer，md、hljs、webshot、reboot、dbadmin、sticker 又依赖 HTMLService；
    // Koishi 对缺失依赖不报错、只静默不加载，所以必须显式装上
    ctx.plugin(PluginPuppeteer, puppeteerConfig())
    // 适配器发送语音需要
    ctx.plugin(PluginSilk)
    ctx.plugin(PluginAdmin) // channel user auth
    ctx.plugin(PluginBind)
    ctx.plugin(PluginCallme)
    ctx.plugin(PluginEcho)
    ctx.plugin(PluginRateLimit)
    ctx.plugin(PluginRecall)
  })

  // 网页控制台
  app.plugin(function PluginCollectionConsole(ctx) {
    ctx.plugin(PluginConsole, consoleConfig())
    ctx.plugin(PluginAuth, { admin: { enabled: false } })
    ctx.plugin(PluginLogger)
    ctx.plugin(PluginStatus)
    ctx.plugin(PluginLlmDashboard)
    ctx.plugin(PluginLlmAdmin)
  })

  // SILI Core
  app.plugin(function PluginCollectionSILICore(ctx) {
    ctx.plugin(PluginAbout)
    ctx.plugin(PluginDice)
    ctx.plugin(PluginHljs)
    ctx.plugin(PluginMarkdown)
    ctx.plugin(PluginLLM, llmConfig(env))
    ctx.plugin(PluginGelbooru, gelbooruConfig(env))
    ctx.plugin(PluginGithub, githubConfig(env))
    ctx.plugin(PluginPing)
    ctx.plugin(PluginProfile)
    ctx.plugin(PluginQueue)
    ctx.plugin(PluginSticker)
    ctx.plugin(PluginToImage)
    ctx.plugin(PluginWebShot)
  })

  // Internal utils
  app.plugin(function PluginCollectionInternal(ctx) {
    ctx.command('admin', '维护指令集')
    ctx.command('tools', '实用工具集')
    ctx.plugin(HTMLService)
    ctx.plugin(FallbackHandler)
    ctx.plugin(SilentSwitch)
    ctx.plugin(PatchCallme)
    ctx.plugin(PiggybackService)
    ctx.plugin(PluginDatabaseAdmin)
    ctx.plugin(PluginHomo)
    ctx.plugin(PluginReboot)
    ctx.plugin(PluginSensitiveFilter)
    ctx.plugin(PluginSpawn)
  })
}

const v5: Profile = { appOptions, install }

export default v5
