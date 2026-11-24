/**
 * v5 runs the official QQ bot alongside the other adapters. OneBot
 * handles legacy binding during the migration window.
 *
 * Access control (src/plugins/qqbot): every ordinary plugin is installed in
 * the served context, so unactivated groups, stranger DMs and OneBot never
 * reach it. Only adapters, the qqbot service, plugin-admin (`assign`) and
 * plugin-bind sit outside. Keep new plugins inside `served`.
 */
import { App, Context, Session, h } from 'koishi'

import process from 'node:process'

import AdapterMinecraft from '@/adapters/queqiao-minecraft'
import { logProcessErrors } from '@/bootstrap'
import CommandPermissions from '@/modules/CommandPermissions'
import FallbackHandler from '@/modules/FallbackHandler'
import HelpAuthorityHint from '@/modules/HelpAuthorityHint'
import MoegirlGroupUtils from '@/modules/MoegirlGroupUtils'
import PlainTextAt from '@/modules/PlainTextAt'
import PluginFeature from '@/plugins/feature'
import PluginMute from '@/plugins/mute'
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
  stickerPoolConfig,
} from '@/profiles/shared/plugin-configs'
import type { Profile } from '@/profiles/types'
import PiggybackService from '@/services/PiggybackService'
import ChannelMessageHistory, {
  isDirectMessage,
} from '@/services/channel-message-history'
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
import PluginLinux from '~/linux'
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
  isGuardedSession,
  servedFilter,
} from '~/qqbot'
import PluginQueue from '~/queue'
import PluginReboot from '~/reboot'
import PluginRepeater from '~/repeater'
import PluginSensitiveFilter from '~/sensitive-words-filter'
import PluginSpawn from '~/spawn'
import PluginSticker from '~/sticker'
import PluginStickerPool from '~/sticker-pool'
import PluginToImage from '~/to-image'
import PluginVersion from '~/version'
import PluginWebShot from '~/webshot'
import PluginWhoAsked from '~/who-asked'
import PluginWikiJoinVerify, {
  type Site as JoinVerifySite,
} from '~/wiki-join-verify'

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
import * as PluginFeedback from 'koishi-plugin-feedback'
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
import * as PluginStickerAdmin from 'koishi-plugin-sticker-admin'
import * as PluginLinuxAdmin from 'koishi-plugin-linux-admin'

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
      // 官方 QQ：常规前缀（迁移过来的用户沿用原来的 `!`）始终有效；slash 只在
      // 私聊、@ 了 SILI 或以昵称呼叫 SILI 时有效。群里可能有其他开了全量消息的
      // bot，裸发的 `/help` 会让它们一起响应，而 QQ 指令面板发出的是 `@bot /cmd`。
      // 昵称呼叫也算：开头喊名字再跟斜杠指令，意图是明确的。纯文本「@名字」
      // 只按平台名称算呼叫（见 PlainTextAt）。
      // 私聊里 Koishi 本就不要求前缀。
      if (['qq', 'qqguild'].includes(session.platform)) {
        const prefixes = env.KOISHI_PREFIX?.split('|') || []
        return session.isDirect ||
          session.stripped?.atSelf ||
          session.stripped?.appel
          ? ['/', ...prefixes]
          : prefixes
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
  // At the root, outside `served`: it must fix `session.stripped` before
  // anything reads it, access control included.
  app.plugin(PlainTextAt)

  /** 安装适配器 */
  app.plugin(function PluginCollectionAdapters(ctx) {
    // 官方 QQ bot。使用适配器默认的 intents（含入群申请等群事件需要的 GROUP_MEMBER_EVENT）。
    if (env.QQBOT_APPID) {
      ctx.plugin(AdapterQQ, {
        id: env.QQBOT_APPID,
        secret: env.QQBOT_SECRET,
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

    // The Minecraft adapter also exposes server commands independently of the chat relay.
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

  app.plugin(ChannelMessageHistory, {
    isServed: (session, outgoing) =>
      outgoing && isQQ(session) && isDirectMessage(session)
        ? state.isDmAllowed(
            session.platform,
            session.selfId,
            session.channelId?.replace(/^private:/, '') ?? ''
          )
        : state.isServedSession(session),
  })

  // 访问控制与迁移入口：必须在已服务上下文之外，未激活的群和陌生私聊也要能用到
  // assign、bind 和群迁移命令。
  app.plugin(function PluginCollectionAccess(ctx) {
    ctx.plugin(QQBotService, {
      state,
      migrationWindow: !!env.ONEBOT_SELFID,
    })
    // 服务等级：每个指令在哪些群和私聊能用，以及 `feature` 指令（含激活）
    ctx.plugin(PluginFeature, {
      featLevels: { help: 0, novelai: 100 },
    })
    ctx.plugin(PluginAdmin) // channel user auth, assign
    // `group:admin` 权限、authority 与 permissions 并写时补 authority:n、放开 `channel` 父指令
    ctx.plugin(CommandPermissions)
    ctx.plugin(PluginBind)
  })

  const served = app.intersect(servedFilter(state))
  const servedNotQQ = served.exclude(isQQ)
  // Served sessions plus unactivated QQ groups and DMs, for the plugins behind
  // the public commands. The qqbot gate decides what reaches them from an
  // unactivated group or DM: only the public commands (and wiki links in groups).
  const publicGroups = app.intersect(
    (session) => servedFilter(state)(session) || isGuardedSession(session)
  )

  // 核心与通用
  served.plugin(function PluginCollectionCore(ctx) {
    ctx.plugin(PluginCommands)
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
    // Login events have no channel, but Status needs them to initialize and dispose bot counters.
    ctx
      .union(
        ({ type }) =>
          type === 'login-added' ||
          type === 'login-removed' ||
          type === 'login-updated'
      )
      .plugin(PluginStatus)
    ctx.plugin(PluginSandbox)
    ctx.plugin(PluginLlmDashboard)
    ctx.plugin(PluginLlmAdmin)
    // 频道管理器：查看官方 bot 所在的群和私聊过的人，激活或取消（authority 4）
    ctx.plugin(PluginQQBotAdmin)
    // 表情库：上传、打标、禁用、自动收集的开关与上限（authority 4）
    ctx.plugin(PluginStickerAdmin)
    // 用户反馈：只有聊天 LLM 能提交，在控制台查看（authority 4）
    ctx.plugin(PluginFeedback)
    // SILI 的 Linux 机器：终端、文件、状态（authority 4）；等 linux 服务就绪
    ctx.plugin(PluginLinuxAdmin)
  })

  // 第三方
  served.plugin(function PluginCollectionThirdParty(ctx) {
    ctx.plugin(PluginImageSearch, {
      saucenaoApiKey: env.TOKEN_SAUCENAO_APIKEY,
    })
    ctx.plugin(PluginSchedule)
    ctx.plugin(PluginBasedata)
  })

  // 服务等级 0 的指令所在的插件：未激活的群和私聊也要收得到（PluginFeature 启动时会检查）
  publicGroups.plugin(function PluginCollectionPublic(ctx) {
    ctx.plugin(PluginHelp)
    ctx.plugin(PluginGithub, githubConfig(env))
    ctx.plugin(PluginManosabaMemes)
    ctx.plugin(PluginAbout)
    ctx.plugin(PluginDice)
    ctx.plugin(PluginSticker)
    ctx.plugin(PluginMediawiki, mediawikiConfig())
  })

  served.plugin(PluginCollectionDialogue)

  // SILI Core
  served.plugin(function PluginCollectionSILICore(ctx) {
    ctx.plugin(PluginHljs)
    ctx.plugin(PluginMarkdown)
    ctx.plugin(PluginMinecraft)
    // 服务等级 100（见 PluginFeature 配置），按群用 `feature -e novelai` 打开
    installNovelAI(ctx)
    const stickers = stickerPoolConfig(env)
    if (stickers) ctx.plugin(PluginStickerPool, stickers)
    ctx.inject(['channelMessageHistory'], (ctx) => {
      ctx.plugin(PluginLLM, llmConfig(env))
      ctx.plugin(PluginWhoAsked)
    })
    // 服务等级 100，按会话用 `feature -e linux` 打开
    ctx.inject(['llm', 'feature'], (ctx) => {
      ctx.plugin(PluginLinux, {
        dataDir: `${ctx.baseDir}/data/linux`,
        proxy: env.http_proxy || env.HTTP_PROXY,
      })
    })
    // 服务等级 100（声明在插件里），按群用 `feature -e comfyui` 打开
    ctx.plugin(PluginComfyUI, comfyUIConfig(env, ctx.baseDir, []))
    ctx.plugin(PluginGelbooru, gelbooruConfig(env))
    ctx.plugin(PluginPing)
    ctx.plugin(PluginPowerUser)
    ctx.plugin(PluginProfile)
    ctx.plugin(PluginQueue)
    ctx.plugin(PluginToImage)
    ctx.plugin(PluginWebShot)
    ctx.plugin(PluginPixiv, pixivConfig(env))
    ctx.plugin(PluginWikiJoinVerify, { sites: joinVerifySites(env) })
    ctx.plugin(PluginMute)
  })

  servedNotQQ.plugin(PluginCanIUse)

  // Internal utils
  served.plugin(function PluginCollectionInternal(ctx) {
    ctx.command('admin', '维护指令集')
    ctx.command('tools', '实用工具集')
    ctx.plugin(HTMLService)
    ctx.plugin(FallbackHandler)
    ctx.plugin(HelpAuthorityHint)
    ctx.plugin(PatchCallme)
    ctx.plugin(PiggybackService)
    ctx.plugin(PluginDatabaseAdmin)
    ctx.plugin(PluginDebug)
    ctx.plugin(PluginVersion)
    ctx.plugin(MoegirlGroupUtils, {
      groupIds: (env.CHANNEL_QQ_MOEGIRL_BFANS ?? '').split('|').map((id) => id.trim()).filter(Boolean),
      keywords: (env.MOEGIRL_KEYWORDS_BLACKLIST ?? '').split('\n').map((pattern) => pattern.trim()).filter(Boolean),
    })
    ctx.channel().plugin(PluginRepeater, {
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
    ctx.plugin(PluginHomo)
    ctx.plugin(PluginReboot)
    ctx.plugin(PluginSensitiveFilter)
    ctx.plugin(PluginSpawn)
  })
}

const v5: Profile = { appOptions, install }

export default v5

/**
 * Groups whose join requests SILI verifies, by SILI Official's group openids.
 * Test groups of other bots (e.g. Noir) come from JOIN_VERIFY_TEST_CHANNELS:
 * `<site key>:<openid>[:<group>|<group>]`, comma-separated.
 */
function joinVerifySites(env: NodeJS.ProcessEnv): JoinVerifySite[] {
  const sites: JoinVerifySite[] = [
    {
      key: 'moegirl',
      label: '萌娘百科',
      api: 'https://mzh.moegirl.org.cn/api.php',
      articleUrl: 'https://zh.moegirl.org.cn/$1',
      verifyPage: 'QQVerify',
      channels: [
        // 编辑讨论群 Promax / Pro / Plus
        { id: 'AC4CF6832AD4E74EDD7B6D6F92CD1256' },
        { id: '7CD2F5D68549F3545058341B1FD39255' },
        { id: 'AFFDD654537CD59DB722B17DC4F883D3' },
        // 限水编辑交流群
        { id: '9DE06079343B7CE28013D75AC56A6E9A', groups: ['autoconfirmed'] },
        // 技术编辑群
        {
          id: 'AC4CF6832AD4E74E1774C9A236FD87FB',
          groups: ['techeditor', 'interface-admin', 'staff', 'sysop'],
        },
        // 界面管理员群
        { id: '11EF1FC331916996FB79BD94D450BECC', groups: ['interface-admin'] },
        // 维护组群
        {
          id: 'DEBF09DFCC993859AF37B2146BB30CE3',
          groups: ['staff', 'sysop', 'patroller'],
          tempMinDays: 7,
        },
      ],
    },
    {
      key: 'fandom',
      label: 'Fandom',
      api: 'https://community.fandom.com/zh/api.php',
      articleUrl: 'https://community.fandom.com/zh/wiki/$1',
      verifyPage: 'qq-hash',
      // Fandom中文
      channels: [{ id: 'AC4CF6832AD4E74E2C317F591B7B85A7' }],
    },
  ]
  for (const entry of env.JOIN_VERIFY_TEST_CHANNELS?.split(',') ?? []) {
    const [key, id, groups] = entry.trim().split(':')
    const site = sites.find((s) => s.key === key)
    if (site && id)
      site.channels.push({ id, groups: groups?.split('|').filter(Boolean) })
  }
  return sites
}
