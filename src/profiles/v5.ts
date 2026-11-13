/**
 * v5 profile: the official QQ bot replaces OneBot; every other adapter keeps
 * serving. Plugins come back in phases, see
 * docs/superpowers/specs/2026-11-13-sili-profiles-design.md. Phases 1 and 2
 * are in; phase-3 plugins (OneBot-specific APIs) are not installed.
 *
 * Access control (src/plugins/qqbot): every ordinary plugin is installed in
 * the served context, so unactivated groups, stranger DMs and OneBot never
 * reach it. Only adapters, the qqbot service, plugin-admin (`assign`) and
 * plugin-bind sit outside. Keep new plugins inside `served`.
 */
import { App, Context, Session } from 'koishi'

import process from 'node:process'

import AdapterMinecraft from '@/adapters/queqiao-minecraft'
import { logProcessErrors } from '@/bootstrap'
import FallbackHandler from '@/modules/FallbackHandler'
import MessagesLogger from '@/modules/MessagesLogger'
import SilentSwitch from '@/modules/SilentSwitch'
import { PluginCollectionDialogue } from '@/profiles/shared/dialogue'
import { installNovelAI } from '@/profiles/shared/novelai'
import {
  assetsS3Config,
  comfyUIConfig,
  consoleConfig,
  gelbooruConfig,
  githubConfig,
  llmConfig,
  mediawikiConfig,
  pixivConfig,
  puppeteerConfig,
} from '@/profiles/shared/plugin-configs'
import type { Profile } from '@/profiles/types'
import PiggybackService from '@/services/PiggybackService'
import HTMLService from '@/services/html'

import PluginAbout from '~/about'
import PatchCallme from '~/callme'
import PluginCanIUse from '~/caniuse'
import PluginComfyUI from '~/comfy-ui'
import PluginDatabaseAdmin from '~/dbadmin'
import PluginDice from '~/dice'
import PluginGelbooru from '~/gelbooru'
import PluginGithub from '~/github'
import PluginHljs from '~/hljs'
import { PluginHomo } from '~/homo'
import PluginLLM from '~/llm'
import PluginMarkdown from '~/md'
import PluginMediawiki from '~/mediawiki'
import PluginMinecraft from '~/minecraft'
import PluginPing from '~/ping'
import PluginPixiv from '~/pixiv'
import PluginPowerUser from '~/power-user'
import PluginProfile from '~/profile'
import QQBotService, {
  ServedState,
  accessAppOptions,
  servedFilter,
} from '~/qqbot'
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
import PluginAnalytics from '@koishijs/plugin-analytics'
import PluginAuth from '@koishijs/plugin-auth'
import * as PluginBind from '@koishijs/plugin-bind'
import * as PluginBroadcast from '@koishijs/plugin-broadcast'
import * as PluginCallme from '@koishijs/plugin-callme'
import PluginCommands from '@koishijs/plugin-commands'
import PluginConsole from '@koishijs/plugin-console'
import PluginDataview from '@koishijs/plugin-dataview'
import * as PluginEcho from '@koishijs/plugin-echo'
import PluginExplorer from '@koishijs/plugin-explorer'
import * as PluginHelp from '@koishijs/plugin-help'
import PluginInsight from '@koishijs/plugin-insight'
import * as PluginLogger from '@koishijs/plugin-logger'
import * as PluginSandbox from '@koishijs/plugin-sandbox'
import * as PluginStatus from '@koishijs/plugin-status'

import AdapterOnebot from 'koishi-plugin-adapter-onebot'
import AdapterQQ from 'koishi-plugin-adapter-qq-crack'
import PluginAssetsS3 from 'koishi-plugin-assets-s3'
import * as PluginBasedata from 'koishi-plugin-basedata'
import * as PluginImageSearch from 'koishi-plugin-image-search'
import * as PluginLlmAdmin from 'koishi-plugin-llm-admin'
import * as PluginLlmDashboard from 'koishi-plugin-llm-dashboard'
import * as PluginManosabaMemes from 'koishi-plugin-manosaba-memes'
import PluginPuppeteer from 'koishi-plugin-puppeteer'
import * as PluginQQBotAdmin from 'koishi-plugin-qqbot-admin'
import * as PluginRateLimit from 'koishi-plugin-rate-limit'
import * as PluginRecall from 'koishi-plugin-recall'
import * as PluginSchedule from 'koishi-plugin-schedule'
import PluginSilk from 'koishi-plugin-silk'
import * as PluginSwitch from 'koishi-plugin-switch'

import PluginHTTP from '@cordisjs/plugin-http'

const { env } = process

/**
 * Served state shared by the App options (autoAuthorize / autoAssign, read by
 * Koishi on every session) and the qqbot service. One per process.
 */
const state = new ServedState()

/** Not adapted to the official QQ bot yet (forward messages, file logs). */
const isQQ = (session: Session) =>
  session.platform === 'qq' || session.platform === 'qqguild'

function appOptions(env: NodeJS.ProcessEnv): Partial<Context.Config> {
  return {
    prefix: (session) => {
      // 官方 QQ：slash（QQ 客户端的指令习惯）加上常规前缀，迁移过来的用户沿用
      // 原来的 `!`。私聊里 Koishi 本就不要求前缀，所以私聊三种写法都能触发。
      if (['qq', 'qqguild'].includes(session.platform)) {
        return ['/', ...(env.KOISHI_PREFIX?.split('|') || [])]
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
    ...accessAppOptions(state),
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
        // Keep off: the adapter writes sender names back by creating a user row
        // for every unknown sender (bypassing the access-control guards), with
        // `authority: config.autoAuthorize || 1`, which stores nothing when
        // autoAuthorize is a function, leaving users at authority 0. Names are
        // kept in qqbot_user instead.
        disableUserNamePersist: true,
      } as any)
    }

    // 迁移期：OneBot 只接收 bind 绑定码，其余一律闭麦（由 qqbot 服务的守卫保证）。
    // 迁移期结束删除 ONEBOT_SELFID 即不再加载。
    if (env.ONEBOT_SELFID) {
      ctx.plugin(AdapterOnebot, {
        protocol: env.ONEBOT_PROTOCOL,
        selfId: env.ONEBOT_SELFID.trim(),
        endpoint: env.ONEBOT_ENDPOINT,
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

  // 访问控制与迁移入口：必须在已服务上下文之外，未激活的群和陌生私聊也要能用到
  // assign、bind 和群迁移命令。
  app.plugin(function PluginCollectionAccess(ctx) {
    ctx.plugin(QQBotService, {
      state,
      migrationWindow: !!env.ONEBOT_SELFID,
    })
    ctx.plugin(PluginAdmin) // channel user auth, assign
    ctx.plugin(PluginBind)
  })

  const served = app.intersect(servedFilter(state))
  const servedNotQQ = served.exclude(isQQ)

  // 核心与通用
  served.plugin(function PluginCollectionCore(ctx) {
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
    ctx.plugin(PluginBroadcast)
    ctx.plugin(PluginCallme)
    ctx.plugin(PluginEcho)
    ctx.plugin(PluginRateLimit)
    ctx.plugin(PluginRecall)
  })

  // 网页控制台
  served.plugin(function PluginCollectionConsole(ctx) {
    ctx.plugin(PluginConsole, consoleConfig())
    ctx.plugin(PluginAnalytics)
    ctx.plugin(PluginAuth, { admin: { enabled: false } })
    ctx.plugin(PluginDataview)
    ctx.plugin(PluginExplorer)
    ctx.plugin(PluginInsight)
    ctx.plugin(PluginLogger)
    ctx.plugin(PluginStatus)
    ctx.plugin(PluginSandbox)
    ctx.plugin(PluginLlmDashboard)
    ctx.plugin(PluginLlmAdmin)
    // 频道管理器：查看官方 bot 所在的群和私聊过的人，激活或取消（authority 4）
    ctx.plugin(PluginQQBotAdmin)
  })

  // 第三方
  served.plugin(function PluginCollectionThirdParty(ctx) {
    ctx.plugin(PluginGithub, githubConfig(env))
    ctx.plugin(PluginImageSearch, {
      saucenaoApiKey: env.TOKEN_SAUCENAO_APIKEY,
    })
    ctx.plugin(PluginSchedule)
    ctx.plugin(PluginBasedata)
    ctx.plugin(PluginManosabaMemes)
  })

  served.plugin(PluginCollectionDialogue)

  // SILI Core
  served.plugin(function PluginCollectionSILICore(ctx) {
    ctx.plugin(PluginAbout)
    ctx.plugin(PluginDice)
    ctx.plugin(PluginHljs)
    ctx.plugin(PluginMarkdown)
    ctx.plugin(PluginMinecraft)
    // 频道仍是 OneBot 的群号，在官方 bot 上待改配置（见 profile spec 的过滤清单）
    installNovelAI(ctx, [
      env.CHANNEL_QQ_SANDBOX,
      env.CHANNEL_QQ_SILI_HOME,
      env.CHANNEL_QQ_NGNL_COMMON,
      env.CHANNEL_QQ_IPE,
    ])
    ctx.plugin(PluginLLM, llmConfig(env))
    // 同上：放行的频道仍是 OneBot 的群号与 QQ 号，待改配置
    ctx.plugin(
      PluginComfyUI,
      comfyUIConfig(env, ctx.baseDir, [
        env.ACCOUNT_QQ_XIAOYUJUN && `private:${env.ACCOUNT_QQ_XIAOYUJUN}`,
        env.CHANNEL_QQ_SANDBOX,
        env.CHANNEL_QQ_NGNL_COMMON,
        env.CHANNEL_QQ_FEIFEIYAOREN,
      ])
    )
    ctx.plugin(PluginGelbooru, gelbooruConfig(env))
    ctx.plugin(PluginPing)
    ctx.plugin(PluginPowerUser)
    ctx.plugin(PluginProfile)
    ctx.plugin(PluginQueue)
    ctx.plugin(PluginSticker)
    ctx.plugin(PluginToImage)
    ctx.plugin(PluginWebShot)
  })

  // 用了官方 bot 不支持的合并转发：先只对 qq 平台屏蔽，其他平台照常
  servedNotQQ.plugin(function PluginCollectionForwardMessages(ctx) {
    ctx.plugin(PluginCanIUse)
    ctx.plugin(PluginPixiv, pixivConfig(env))
    ctx.plugin(PluginMediawiki, mediawikiConfig())
  })

  // Internal utils
  served.plugin(function PluginCollectionInternal(ctx) {
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

  // 文件日志：qq 平台的消息由 qqbot_message 记录
  servedNotQQ.plugin(MessagesLogger)
}

const v5: Profile = { appOptions, install }

export default v5
