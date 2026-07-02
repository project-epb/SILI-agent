import { Context, Schema, Time } from 'koishi'
import BasePlugin from '~/_boilerplate'
import { SubscriptionStore } from './subscribe'
import { applyWebhook } from './webhook'
import type { Config as GitHubConfig } from './types'

// Re-export the config type and the Schema value under the same public name
// (koishi's interface+Schema idiom; aliased import avoids a merged-declaration clash).
export type Config = GitHubConfig

export default class PluginGitHub extends BasePlugin<Config> {
  static inject = ['database', 'server']

  private store = new SubscriptionStore()

  constructor(ctx: Context, config: Config) {
    super(ctx, config, 'github')

    // Reuse the legacy schema verbatim so prod data + registered webhooks keep working.
    ctx.model.extend('user', {
      'github.accessToken': 'string(50)',
      'github.refreshToken': 'string(50)',
    })
    ctx.model.extend('channel', {
      'github.webhooks': 'json',
    })
    ctx.model.extend('github', {
      id: 'integer',
      name: 'string(50)',
      secret: 'string(50)',
    })

    // Rebuild the in-memory subscription index from the channel table on startup.
    ctx.on('ready', async () => {
      const channels = await ctx.database.get('channel', {}, ['id', 'platform', 'github'])
      for (const { id, platform, github } of channels) {
        const webhooks = github?.webhooks ?? {}
        for (const repo in webhooks) {
          this.store.subscribe(repo, `${platform}:${id}`, webhooks[repo])
        }
      }
      this.logger.info('github: subscription index rebuilt')
    })

    applyWebhook(ctx, config, {
      getSecret: async (hookId) => (await ctx.database.get('github', [hookId]))[0]?.secret,
      targets: (repo, event, action) => this.store.targets(repo, event, action),
    })
  }
}

export const Config: Schema<Config> = Schema.object({
  path: Schema.string().default('/github'),
  appId: Schema.string(),
  appSecret: Schema.string(),
  redirect: Schema.string(),
  messagePrefix: Schema.string().default('[GitHub] '),
  replyFooter: Schema.string().role('textarea').default(''),
  replyTimeout: Schema.natural().role('ms').default(Time.hour),
})
