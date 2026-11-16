import { Context, Time } from 'koishi'

import * as PluginDialogue from 'koishi-plugin-dialogue'
import * as PluginDialogueAuthor from 'koishi-plugin-dialogue-author'
import * as PluginDialogueContext from 'koishi-plugin-dialogue-context'
import * as PluginDialogueRateLimit from 'koishi-plugin-dialogue-rate-limit'

const { env } = process

/** Dialogue (问答库) with its rate limits and the two hotfix hooks. */
export function PluginCollectionDialogue(ctx: Context) {
  ctx.plugin(PluginDialogue, {
    prefix: env.KOISHI_ENV === 'prod' ? '?!' : '#',
    // dialogue 有个隐藏的「称呼激活」机制：用户用称呼触发一次问答后，会被加进
    // activated 表（默认持续 10 分钟），期间该用户的 *每一条* 消息都会在
    // before('attach') 里被写穿 session.stripped.appel = true（receiver.ts）。
    // 这会污染下游所有读 stripped 的人 —— FallbackHandler 会把这些消息误判为
    // 「呼唤了 bot」，全部转给 llm chat，表现为“用户说一句 SILI 跟一句”。
    // 设为 0 直接掐掉该粘性窗口。
    appellationTimeout: 0,
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
}
