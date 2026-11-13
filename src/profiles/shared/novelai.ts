import { Context } from 'koishi'

import * as PluginNovelAi from 'koishi-plugin-novelai'

/**
 * NovelAI, only when credentials are configured, limited to `channels`.
 * Channel ids are platform-specific (OneBot group numbers vs official-bot
 * openids), so each profile passes its own.
 */
export function installNovelAI(ctx: Context, channels: (string | undefined)[]) {
  if (!process.env.NOVELAI_USERNAME) return
  // 部分开启 NovelAI 测试
  ctx.channel(...(channels as string[])).plugin(PluginNovelAi, {
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
