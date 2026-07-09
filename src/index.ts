/**
 * @name SILI-agent 万界规划局QQ机器人
 * @author Dragon-Fish <dragon-fish@qq.com>
 *
 * @license MIT
 */
import { config as setupDotEnv } from 'dotenv'

import { App, Time, h } from '@koishijs/core'

import { resolve } from 'node:path'
import process from 'node:process'

import AdapterMinecraft from '@/adapters/queqiao-minecraft'
import FallbackHandler from '@/modules/FallbackHandler'
import { FixQQSendLinks } from '@/modules/FixQQSendLinks'
import { GuildRequestFirewall } from '@/modules/GuildRequestFirewall'
import MessagesLogger from '@/modules/MessagesLogger'
import { MinecraftConnect } from '@/modules/MinecraftConnect'
import MgpGroupUtils from '@/modules/MoegirlGroupUtils'
import ProcessErrorHandler from '@/modules/ProcessErrorHandler'
import PiggybackService from '@/services/PiggybackService'
import { QQNTEmojiReactionService } from '@/services/QQNTEmojiReaction'
import HTMLService from '@/services/html'
import { parseLLMProviders } from '@/utils/parseLLMProviders'

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
import AdapterQQ, { QQ } from '@koishijs/plugin-adapter-qq'
import * as PluginAdmin from '@koishijs/plugin-admin'
import PluginAnalytics from '@koishijs/plugin-analytics'
import PluginAuth from '@koishijs/plugin-auth'
import * as PluginBind from '@koishijs/plugin-bind'
import * as PluginBroadcast from '@koishijs/plugin-broadcast'
import * as PluginCallme from '@koishijs/plugin-callme'
import PluginCommands from '@koishijs/plugin-commands'
import PluginConsole from '@koishijs/plugin-console'
import PluginMongo from '@koishijs/plugin-database-mongo'
import PluginDataview from '@koishijs/plugin-dataview'
import * as PluginEcho from '@koishijs/plugin-echo'
import PluginExplorer from '@koishijs/plugin-explorer'
import * as PluginHelp from '@koishijs/plugin-help'
import PluginInsight from '@koishijs/plugin-insight'
import * as PluginLogger from '@koishijs/plugin-logger'
import * as PluginSandbox from '@koishijs/plugin-sandbox'
import PluginServer from '@koishijs/plugin-server'
import * as PluginStatus from '@koishijs/plugin-status'

import AdapterOnebot from 'koishi-plugin-adapter-onebot'
import PluginAssetsS3 from 'koishi-plugin-assets-s3'
import * as PluginAutowithdraw from 'koishi-plugin-autowithdraw-fix'
import * as PluginBasedata from 'koishi-plugin-basedata'
import * as PluginDialogue from 'koishi-plugin-dialogue'
import * as PluginDialogueAuthor from 'koishi-plugin-dialogue-author'
import * as PluginDialogueContext from 'koishi-plugin-dialogue-context'
import * as PluginDialogueFlow from 'koishi-plugin-dialogue-flow'
import * as PluginDialogueRateLimit from 'koishi-plugin-dialogue-rate-limit'
import * as PluginImageSearch from 'koishi-plugin-image-search'
import * as PluginManosabaMemes from 'koishi-plugin-manosaba-memes'
import * as PluginNovelAi from 'koishi-plugin-novelai'
import PluginPuppeteer from 'koishi-plugin-puppeteer'
import * as PluginRateLimit from 'koishi-plugin-rate-limit'
import * as PluginRecall from 'koishi-plugin-recall'
import * as PluginSchedule from 'koishi-plugin-schedule'
import PluginSilk from 'koishi-plugin-silk'
import * as PluginSwitch from 'koishi-plugin-switch'

import PluginHTTP from '@cordisjs/plugin-http'
import { executablePath } from 'puppeteer'

const PROD = process.env.NODE_ENV === 'production'

// Setup .env
setupDotEnv()
setupDotEnv({
  path: resolve(
    import.meta.dirname,
    '..',
    PROD ? '.env.production' : '.env.development'
  ),
  override: true,
})
setupDotEnv({
  path: resolve(import.meta.dirname, '..', '.env.local'),
  override: true,
})
const { env } = process

/** 初始化 Koishi 实例 */
const app = new App({
  nickname: env.KOISHI_NICKNAME?.split('|'),
  prefix: (ctx) => {
    // QQ官方适配器，必须at才能收到消息，无需前缀
    if (['qq', 'qqguild'].includes(ctx.platform)) {
      return ''
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
  minSimilarity: 0.8,
  delay: {
    message: 3 * 1000,
    broadcast: 10 * 1000,
    prompt: 60 * 1000,
  },
})
// core services, init immediately
app.plugin(PluginServer, {
  host: '0.0.0.0',
  port: env.KOISHI_PROT ? +env.KOISHI_PROT : undefined,
  selfUrl: env.KOISHI_SELF_URL,
})
const logger = app.logger('INIT')

/** 安装数据库 */
app.plugin(PluginMongo, {
  host: env.DB_MONGO_HOST,
  port: Number(env.DB_MONGO_PORT),
  // username: env.DB_MONGO_USER,
  // password: env.DB_MONGO_PASSWORD,
  database: env.DB_MONGO_DATABASE,
})

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
      sandbox: true,
      id: env.QQBOT_APPID,
      token: env.QQBOT_TOKEN,
      secret: env.QQBOT_SECRET,
      type: env.QQBOT_TYPE,
      intents:
        QQ.Intents.GUILDS |
        QQ.Intents.GUILD_MEMBERS |
        QQ.Intents.PUBLIC_GUILD_MESSAGES |
        QQ.Intents.OPEN_FORUMS_EVENT |
        QQ.Intents.INTERACTIONS |
        QQ.Intents.MESSAGE_AUDIT,
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
    ctx.plugin(PluginAssetsS3, {
      credentials: {
        accessKeyId: env.TOKEN_S3_ACCESS_KEY_ID,
        secretAccessKey: env.TOKEN_S3_ACCESS_KEY_SECRET,
      },
      bucket: env.TOKEN_S3_BUCKET,
      pathPrefix: env.KOISHI_ENV === 'prod' ? 'v4/assets/' : 'v4-dev/assets/',
      publicUrl: `${env.TOKEN_S3_PUBLIC_URL}/${
        env.KOISHI_ENV === 'prod' ? 'v4/assets/' : 'v4-dev/assets/'
      }`,
      region: env.TOKEN_S3_REGION,
      endpoint: env.TOKEN_S3_ENDPOINT,
    })
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
  ctx.plugin(PluginConsole, {
    title: 'SILI 监控中心',
    uiPath: '/dash',
    apiPath: '/api/status',
  })
  ctx.plugin(PluginAnalytics)
  ctx.plugin(PluginAuth, { admin: { enabled: false } })
  ctx.plugin(PluginDataview)
  ctx.plugin(PluginExplorer)
  ctx.plugin(PluginInsight)
  ctx.plugin(PluginLogger)
  ctx.plugin(PluginStatus)
  ctx.plugin(PluginSandbox)
})

// 第三方
app.plugin(async function PluginCollectionThirdParty(ctx) {
  ctx.plugin(PluginGithub, {
    path: '/api/github',
    appId: env.TOKEN_GITHUB_APPID,
    appSecret: env.TOKEN_GITHUB_APPSECRET,
    redirect: env.TOKEN_GITHUB_REDIRECT, // optional override; unset → derived from selfUrl (see applyOAuth)
    replyTimeout: 6 * Time.hour,
    replyFooter:
      '<sub>↪ by [SILI agent](https://github.com/project-epb/SILI-agent)</sub>',
  })
  ctx.plugin(PluginImageSearch, {
    saucenaoApiKey: env.TOKEN_SAUCENAO_APIKEY,
  })
  ctx.plugin(PluginPuppeteer, {
    // headless: 'new',
    executablePath: executablePath(),
  })
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

app.plugin(function PluginCollectionDialogue(ctx) {
  ctx.plugin(PluginDialogue, {
    prefix: env.KOISHI_ENV === 'prod' ? '?!' : '#',
  })
  ctx.plugin(PluginDialogueAuthor)
  ctx.plugin(PluginDialogueContext)
  // ctx.plugin(PluginDialogueFlow)
  ctx.plugin(PluginDialogueRateLimit, {
    throttle: {
      responses: 10,
      interval: 1 * Time.minute,
    },
    preventLoop: {
      length: 3,
      participants: 1,
      debounce: 3 * Time.minute,
    },
  })

  // FIXME: plugin-dialogue 权限漏洞
  // 禁止一般用户查询问答库，避免泄露敏感信息
  ctx.on(
    // @ts-ignore
    'dialogue/before-action',
    (session: PluginDialogue.Dialogue.Session) => {
      const userAuth = session.user?.authority || 0
      if (userAuth <= 2) {
        return '你没有权限执行此操作。'
      }
    }
  )

  // FIXME: plugin-dialogue 逻辑漏洞
  // 当用户仅发送了一个纯 @bot 的消息时，stripped.content 为空，
  // `dialogue/query` hook 不会附加 question 条件，
  // 导致其退化为「全库按 probA 加权随机抽一条」，
  // 表现为「@bot」=「随机回答」。
  ctx.on(
    // @ts-ignore
    'dialogue/receive',
    ({ session }: PluginDialogue.SessionState) => {
      const trimmedContent = session.stripped.content?.trim() || ''
      if (trimmedContent.length <= 0) {
        ctx
          .logger('HOTFIX')
          .warn(`Pure mention triggered random dialogue: ${session.id}`)
        return true
      }
    }
  )
})

// SILI Core
app.plugin(function PluginCollectionSILICore(ctx) {
  ctx.plugin(PluginAbout)
  ctx.plugin(PluginCanIUse)
  ctx.plugin(PluginDice)
  ctx.plugin(PluginHljs)
  ctx.plugin(PluginMarkdown)
  ctx.plugin(PluginMinecraft)
  ctx.plugin(PluginMute)
  if (process.env.NOVELAI_USERNAME) {
    // 部分开启 NovelAI 测试
    ctx
      .channel(
        process.env.CHANNEL_QQ_SANDBOX,
        process.env.CHANNEL_QQ_SILI_HOME,
        process.env.CHANNEL_QQ_NGNL_COMMON,
        process.env.CHANNEL_QQ_IPE
      )
      .plugin(PluginNovelAi, {
        type: 'login',
        email: process.env.NOVELAI_USERNAME,
        password: process.env.NOVELAI_PASSWORD,
        model: 'nai-diffusion-4-5-full',
        basePrompt: 'best quality, amazing quality, very aesthetic, absurdres',
        resolution: { width: 832, height: 1216 },
        scale: 8,
        latinOnly: true,
      })
    ctx.command('novelai', {
      minInterval(session) {
        if ((session.user as any)?.authority > 1) return 0
        return 60 * 1000
      },
      maxUsage(session) {
        if ((session.user as any)?.authority > 1) return undefined
        return 10
      },
    })
  }
  ctx.plugin(PluginLLM, {
    providers: parseLLMProviders(env),
    maxTokens: env.LLM_MAX_TOKENS ? Number(env.LLM_MAX_TOKENS) : 16384,
    model: env.LLM_MODEL || 'gpt-4o',
    memoryModel: env.LLM_AGENT_MEMORY_MODEL,
    // IM 场景下 50 turn 就几千 token，DeepSeek 类便宜模型完全 cover；
    // 切贵模型时记得把这个数字也调小。
    historyTurnCount: 50,
    sessionIdleTimeoutMs: env.LLM_SESSION_IDLE_HOURS
      ? Number(env.LLM_SESSION_IDLE_HOURS) * 60 * 60 * 1000
      : undefined,
    tavily: env.LLM_TAVILY_API_KEY
      ? { apiKey: env.LLM_TAVILY_API_KEY }
      : undefined,
  })
  // ComfyUI 图像生成：从 data/comfyui 加载 workflow/guide（容器里 /app/data，
  // 即宿主机 .volumns/core/comfyui/）；后端 baseURL + 认证走 .env（沿用 Hermes
  // 变量名）。未配 COMFYUI_BASE_URL 时插件惰性无害（命令仍注册，generate 返回
  // 未配置提示）。
  ctx.plugin(PluginComfyUI, {
    http: env.COMFYUI_BASE_URL
      ? {
          baseURL: env.COMFYUI_BASE_URL,
          headers:
            env.CF_SERVICE_TOKEN_ID && env.CF_SERVICE_TOKEN_SECRET
              ? {
                  'CF-Access-Client-Id': env.CF_SERVICE_TOKEN_ID,
                  'CF-Access-Client-Secret': env.CF_SERVICE_TOKEN_SECRET,
                }
              : undefined,
        }
      : undefined,
    workflows: PluginComfyUI.scanWorkflowTemplates(
      resolve(ctx.baseDir, 'data/comfyui/workflows')
    ),
    guides: PluginComfyUI.scanGuides(
      resolve(ctx.baseDir, 'data/comfyui/guides')
    ),
    // 临时措施：放行沙盒群 / NGNL 群 / 站长私聊（复用现有 .env 变量；CHANNEL_QQ_*
    // 是群 channelId，站长私聊用 private:<QQ号>）。都未配则为空数组 = 不限。
    allowedChannels: [
      env.ACCOUNT_QQ_XIAOYUJUN && `private:${env.ACCOUNT_QQ_XIAOYUJUN}`,
      env.CHANNEL_QQ_SANDBOX,
      env.CHANNEL_QQ_NGNL_COMMON,
    ].filter(Boolean) as string[],
    // 访问控制（防群友刷爆显卡）：可经 .env 调整，缺省给保护性默认。
    // COMFYUI_GENERATE_MIN_INTERVAL_S 单位为秒（转成 ms）。
    generate: {
      authority: env.COMFYUI_GENERATE_AUTHORITY
        ? Number(env.COMFYUI_GENERATE_AUTHORITY)
        : 1,
      minInterval: env.COMFYUI_GENERATE_MIN_INTERVAL_S
        ? Number(env.COMFYUI_GENERATE_MIN_INTERVAL_S) * 1000
        : 30_000,
      maxUsage: env.COMFYUI_GENERATE_MAX_USAGE
        ? Number(env.COMFYUI_GENERATE_MAX_USAGE)
        : 0,
    },
    // 提示词过滤（按需启用）：blacklist 命中即拒绝、force* 追加强制词，Computed 可按群。
    // 复杂逻辑用 ctx.on('comfyui/before-generate', ...) 自己写监听器。
    // filter: {
    //   blacklist: (s) => s.channelId === env.CHANNEL_QQ_XXX ? ['nsfw', 'nude'] : [],
    //   forceNegative: 'nsfw, nude',
    // },
  })
  // Gelbooru 标签/图片查询（agent 工具，只读）：凭据走 .env，未配则惰性无害
  // （命令仍注册，调用返回未配置提示）。imageBlacklist 可按需启用，Computed 按群。
  ctx.plugin(PluginGelbooru, {
    apiKey: env.GELBOORU_API_KEY,
    userId: env.GELBOORU_USER_ID,
    // 含敏感标签的 post 去缩略图（保留 tags/score 供 agent 写 prompt 参考）。
    // imageBlacklist: (s) =>
    //   s.channelId === env.CHANNEL_QQ_XXX ? [] : ['nsfw', 'nude', 'explicit'],
  })
  ctx.plugin(PluginPing)
  ctx.plugin(PluginPixiv, {
    apiBaseURL: env.PIXIV_API_BASE,
    webBaseURL: env.PIXIV_WEB_BASE,
    pximgBaseURL: env.PIXIV_IMG_BASE,
  })
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
  ctx.plugin(PluginMediawiki, {
    searchIfNotExist: true,
    showDetailsByDefault: true,
    cmdAuthConnect: 2,
  })
})

// Internal utils
app.plugin(function PluginCollectionInternal(ctx) {
  ctx.command('admin', '维护指令集')
  ctx.command('tools', '实用工具集')
  ctx.plugin(HTMLService)
  ctx.plugin(FallbackHandler)
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

/** 启动应用程序 */
app.start().then(() => {
  logger.info('🌈', 'SILI启动成功~')
})
