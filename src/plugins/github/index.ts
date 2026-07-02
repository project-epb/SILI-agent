import { Context, Schema, Time } from 'koishi'
import BasePlugin from '~/_boilerplate'
import { SubscriptionStore } from './subscribe'
import { applyWebhook } from './webhook'
import { GitHubHttp } from './http'
import { applyOAuth } from './oauth'
import { applyCommands, makeRepoStore } from './commands'
import { migrateRepoRename } from './rename'
import type { Config as GitHubConfig } from './types'

// Re-export the config type and the Schema value under the same public name
// (koishi's interface+Schema idiom; aliased import avoids a merged-declaration clash).
export type Config = GitHubConfig

export default class PluginGitHub extends BasePlugin<Config> {
  static inject = ['database', 'server', 'http']

  static Config: Schema<Config> = Schema.object({
    path: Schema.string().default('/github'),
    appId: Schema.string(),
    appSecret: Schema.string(),
    redirect: Schema.string(),
    messagePrefix: Schema.string().default('[GitHub] '),
    replyFooter: Schema.string().role('textarea').default(''),
    replyTimeout: Schema.natural().role('ms').default(Time.hour),
    bodyMaxLength: Schema.natural().default(500),
  })

  private store = new SubscriptionStore()

  constructor(ctx: Context, config: Config) {
    super(ctx, config, 'github')

    // Reuse the legacy schema verbatim so prod data + registered webhooks keep working.
    ctx.model.extend('user', {
      'github.accessToken': 'string(50)',
      'github.refreshToken': 'string(50)',
      'github.username': 'string(50)',
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
      this.logger.info('subscription index rebuilt')
    })

    const http = new GitHubHttp(ctx, this.config)
    const repoStore = makeRepoStore(ctx)

    applyOAuth(ctx, this.config, http)
    applyCommands(ctx, this.config, http, this.store, repoStore)

    applyWebhook(ctx, this.config, {
      getHook: async (hookId) => {
        const [row] = await ctx.database.get('github', [hookId])
        return row ? { name: row.name, secret: row.secret } : undefined
      },
      targets: (repo, event, action) => this.store.targets(repo, event, action),
      onRename: (hookId, oldName, newName, secret) =>
        migrateRepoRename(hookId, oldName, newName, secret, this.store, {
          setHookName: async (id, name, sec) => {
            await ctx.database.set('github', id, { name, secret: sec })
          },
          getChannels: () => ctx.database.get('channel', {}, ['id', 'platform', 'github']) as any,
          upsertChannels: async (rows) => {
            await ctx.database.upsert('channel', rows)
          },
        }),
    })
  }
}
