/**
 * v4 profile: SILI on OneBot (NapCat) plus every other adapter. This is the
 * pre-profile src/index.ts moved verbatim, kept as the rollback target.
 *
 * Plugin registration order is load-bearing: prepend middleware run in
 * reverse registration order (FallbackHandler relies on it). Do not reorder
 * or move calls into shared helpers at different positions.
 */
import { App, Context, h } from 'koishi'

import process from 'node:process'

import AdapterMinecraft from '@/adapters/queqiao-minecraft'
import FallbackHandler from '@/modules/FallbackHandler'
import { FixQQSendLinks } from '@/modules/FixQQSendLinks'
import { GuildRequestFirewall } from '@/modules/GuildRequestFirewall'
import MessagesLogger from '@/modules/MessagesLogger'
import { MinecraftConnect } from '@/modules/MinecraftConnect'
import MgpGroupUtils from '@/modules/MoegirlGroupUtils'
import ProcessErrorHandler from '@/modules/ProcessErrorHandler'
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
import { QQNTEmojiReactionService } from '@/services/QQNTEmojiReaction'
import HTMLService from '@/services/html'

import PluginAbout from '~/about'
import PatchCallme from '~/callme'
import PluginCanIUse from '~/caniuse'
import PluginComfyUI from '~/comfy-ui'
import PluginDatabaseAdmin from '~/dbadmin'
import { PluginDebug } from '~/debug'
import PluginDice from '~/dice'
import PluginGelbooru from '~/gelbooru'
import PluginGithub from '~/github'
import PluginHljs from '~/hljs'
import { PluginHomo } from '~/homo'
import PluginLLM from '~/llm'
import PluginMarkdown from '~/md'
import PluginMediawiki from '~/mediawiki'
import PluginMinecraft from '~/minecraft'
import PluginMute from '~/mute'
import PluginPing from '~/ping'
import PluginPixiv from '~/pixiv'
import PluginPowerUser from '~/power-user'
import PluginProfile from '~/profile'
import PluginQueue from '~/queue'
import PluginReboot from '~/reboot'
import PluginRepeater from '~/repeater'
import PluginSensitiveFilter from '~/sensitive-words-filter'
import PluginSiliName from '~/sili-name'
import PluginSpawn from '~/spawn'
import PluginSticker from '~/sticker'
import PluginToImage from '~/to-image'
import PluginVerifyFandomUser from '~/verify-fandom-user'
import PluginVersion from '~/version'
import PluginWebShot from '~/webshot'
import PluginWhoAsked from '~/who-asked'
import PluginYoudao from '~/youdao'

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
import * as PluginAutowithdraw from 'koishi-plugin-autowithdraw-fix'
import * as PluginBasedata from 'koishi-plugin-basedata'
import * as PluginImageSearch from 'koishi-plugin-image-search'
import * as PluginLlmAdmin from 'koishi-plugin-llm-admin'
import * as PluginLlmDashboard from 'koishi-plugin-llm-dashboard'
import * as PluginManosabaMemes from 'koishi-plugin-manosaba-memes'
import PluginPuppeteer from 'koishi-plugin-puppeteer'
import * as PluginRateLimit from 'koishi-plugin-rate-limit'
import * as PluginRecall from 'koishi-plugin-recall'
import * as PluginSchedule from 'koishi-plugin-schedule'
import PluginSilk from 'koishi-plugin-silk'
import * as PluginSwitch from 'koishi-plugin-switch'

import PluginHTTP from '@cordisjs/plugin-http'

const { env } = process

function appOptions(env: NodeJS.ProcessEnv): Partial<Context.Config> {
  return {
    prefix: (ctx) => {
      // QQ官方适配器，如果没有 at，则使用 slash
      if (['qq', 'qqguild'].includes(ctx.platform)) {
        return '/'
      }
      // 钉钉适配器，必须at才能收到消息，无需前缀
      if (ctx.platform === 'dingtalk') {
        return ''
      }
      const prefixes = env.KOISHI_PREFIX?.split('|') || []
      if (['villa', 'discord'].includes(ctx.platform)) {
        prefixes.unshift('/')
      }
      return prefixes
    },
  }
}

function install(app: App) {
  /** 安装适配器 */
  app.plugin(function PluginCollectionAdapters(ctx) {
    // QQ
    if (process.env.ONEBOT_SELFID) {
      ctx.plugin(AdapterOnebot, {
        protocol: env.ONEBOT_PROTOCOL,
        selfId: env.ONEBOT_SELFID?.trim(),
        endpoint: env.ONEBOT_ENDPOINT,
      })
    }
    if (process.env.QQBOT_APPID) {
      ctx.plugin(AdapterQQ, {
        id: env.QQBOT_APPID,
        secret: env.QQBOT_APPSECRET,
        type: env.QQBOT_TYPE,
        // intents:
        //   AdapterQQ.QQ.Intents.GUILDS |
        //   AdapterQQ.QQ.Intents.GUILD_MEMBERS |
        //   AdapterQQ.QQ.Intents.PUBLIC_GUILD_MESSAGES |
        //   AdapterQQ.QQ.Intents.OPEN_FORUMS_EVENT |
        //   AdapterQQ.QQ.Intents.INTERACTIONS |
        //   AdapterQQ.QQ.Intents.MESSAGE_AUDIT,
      })
    }

    // Discord
    if (env.TOKEN_DISCORD_BOT) {
      ctx.plugin(AdapterDiscord, {
        token: env.TOKEN_DISCORD_BOT,
      })
    }

    // DingTalk
    const DINGTALK_AGENTID = process.env.DINGTALK_AGENTID
    const DINGTALK_APPKEY = process.env.DINGTALK_APPKEY
    const DINGTALK_SECRET = process.env.DINGTALK_SECRET
    if (DINGTALK_AGENTID && DINGTALK_APPKEY && DINGTALK_SECRET) {
      ctx.plugin(AdapterDingtalk, {
        protocol: 'ws',
        agentId: +DINGTALK_AGENTID,
        appkey: DINGTALK_APPKEY,
        secret: DINGTALK_SECRET,
      })
      // FIX: AdapterDingtalk 没有正确处理应答，导致钉钉会重复发送消息，我们只能在这里做一下去重处理
      const _handledMsgIds: string[] = []
      ctx.on('message', (session) => {
        if (session.platform !== 'dingtalk') return
        const eventId = session.messageId
        if (_handledMsgIds.includes(eventId)) {
          ctx
            .logger('DINGTALK')
            .debug(`Ignore duplicated event ${eventId} from DingTalk`)
          return ''
        }
        _handledMsgIds.push(eventId)
        if (_handledMsgIds.length > 100) {
          _handledMsgIds.splice(0, _handledMsgIds.length - 100)
        }
      })
    }

    if (env.KOOK_TOKEN) {
      ctx.plugin(AdapterKook, {
        protocol: 'ws',
        token: env.KOOK_TOKEN,
      })
    }

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
      if (env.MINECRAFT_CONNECT_QQ_GROUP) {
        ctx.plugin(MinecraftConnect, [
          {
            qqChannelId: env.MINECRAFT_CONNECT_QQ_GROUP,
            mcServerId: env.MINECRAFT_SERVER_NAME,
          },
        ])
      }
    }

    // 飞书
    if (env.FEISHU_APPID && env.FEISHU_APPSECRET) {
      ctx.plugin(AdapterLark, {
        appId: env.FEISHU_APPID,
        appSecret: env.FEISHU_APPSECRET,
        encryptKey: env.FEISHU_ENCRYPT_KEY,
        verificationToken: env.FEISHU_VERIFICATION_TOKEN,
        protocol: 'ws',
      })
    }

    // Repl
    // ctx.plugin('adapter-repl')
  })

  /** 安装插件 */
  // @pollify v3 自带的指令
  app.plugin(function PluginCollectionLegacy(ctx) {
    // [core]
    ctx.plugin(function PluginCollectionLegacyCore(ctx) {
      ctx.plugin(PluginHelp)
      // ctx.command('help').alias('帮助')
      ctx.plugin(PluginCommands)
      ctx.plugin(PluginSwitch)
      ctx.plugin(PluginAssetsS3, assetsS3Config(env))
      ctx.plugin(PluginHTTP)
    })
    // [common]
    ctx.plugin(function PluginCollectionLegacyCommon(ctx) {
      ctx.plugin(PluginAdmin) // channel user auth
      ctx.plugin(PluginBind)
      ctx.plugin(PluginBroadcast)
      ctx.plugin(PluginCallme)
      ctx.plugin(PluginEcho)
      ctx.plugin(PluginRateLimit)
      ctx.plugin(PluginRecall)
    })
  })

  // 网页控制台
  app.plugin(function PluginCollectionConsole(ctx) {
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
  })

  // 第三方
  app.plugin(async function PluginCollectionThirdParty(ctx) {
    ctx.plugin(PluginGithub, githubConfig(env))
    ctx.plugin(PluginImageSearch, {
      saucenaoApiKey: env.TOKEN_SAUCENAO_APIKEY,
    })
    ctx.plugin(PluginPuppeteer, puppeteerConfig())
    ctx.plugin(PluginSchedule)
    ctx.plugin(PluginSilk)

    // 魔女审判
    ctx.plugin(PluginBasedata)
    ctx.plugin(PluginManosabaMemes)
    //   ctx.command('manosaba').usage(`魔法少女的魔女审判`)
    //   ctx.command('manosaba.安安说').alias('安安说')
    //   ctx.command('manosaba.审判').alias('魔女审判')
    //     .example(`基础陈述：赞同、疑问、伪证、反驳、魔法-角色名
    // 可用角色名：梅露露、诺亚、汉娜、奈叶香、亚里沙、米莉亚、雪莉、艾玛、玛格、安安、可可、希罗、蕾雅`)
  })

  app.plugin(PluginCollectionDialogue)

  // SILI Core
  app.plugin(function PluginCollectionSILICore(ctx) {
    ctx.plugin(PluginAbout)
    ctx.plugin(PluginCanIUse)
    ctx.plugin(PluginDice)
    ctx.plugin(PluginHljs)
    ctx.plugin(PluginMarkdown)
    ctx.plugin(PluginMinecraft)
    ctx.plugin(PluginMute)
    installNovelAI(ctx, [
      process.env.CHANNEL_QQ_SANDBOX,
      process.env.CHANNEL_QQ_SILI_HOME,
      process.env.CHANNEL_QQ_NGNL_COMMON,
      process.env.CHANNEL_QQ_IPE,
    ])
    ctx.plugin(PluginLLM, llmConfig(env))
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
    ctx.plugin(PluginPixiv, pixivConfig(env))
    ctx.plugin(PluginPowerUser)
    ctx.plugin(PluginProfile)
    ctx.plugin(PluginQueue)
    ctx.plugin(PluginSiliName)
    ctx.plugin(PluginSticker)
    ctx.plugin(PluginToImage)
    ctx.plugin(PluginVerifyFandomUser)
    ctx.plugin(PluginVersion)
    ctx.plugin(PluginWebShot)
    ctx.plugin(PluginWhoAsked)
    // ctx.plugin(PluginYoudao)

    // MediaWiki
    ctx.plugin(PluginMediawiki, mediawikiConfig())
  })

  // Internal utils
  app.plugin(function PluginCollectionInternal(ctx) {
    ctx.command('admin', '维护指令集')
    ctx.command('tools', '实用工具集')
    ctx.plugin(HTMLService)
    ctx.plugin(FallbackHandler)
    ctx.plugin(SilentSwitch)
    ctx.plugin(GuildRequestFirewall)
    ctx.plugin(MessagesLogger)
    ctx.plugin(MgpGroupUtils)
    ctx.plugin(PatchCallme)
    ctx.plugin(PiggybackService)
    ctx.plugin(QQNTEmojiReactionService)
    ctx.plugin(ProcessErrorHandler)
    ctx.plugin(PluginDatabaseAdmin)
    ctx.plugin(PluginDebug)
    ctx.plugin(PluginHomo)
    ctx.plugin(PluginReboot)
    ctx.plugin(PluginRepeater, {
      interruptTexts: [
        'No，不要再复读了！',
        '🤚我说婷婷，你们搞复读，不讲武德。',
        '那么就到此为止吧，再复读就不礼貌了。',
        '🤚很抱歉打扰大家的复读，水群不要忘记多喝热水哟~',
      ],
      queryTexts: [
        (_state, breaker) => `${h.at(breaker.userId)}在？为什么打断复读？`,
        (_state, breaker) =>
          `${h.at(breaker.userId)} 你还要继续复读哟，怎么停下来了。`,
      ],
    })
    ctx.plugin(PluginSensitiveFilter)
    ctx.plugin(PluginSpawn)
    // FIXME: 临时修复
    ctx.plugin(FixQQSendLinks)
    ctx.plugin(PluginAutowithdraw, {
      withdrawExpire: 10 * 60, // 10 minutes
      quoteEnable: false,
      loggerinfo: false,
    })
  })
}

const v4: Profile = { appOptions, install }

export default v4
