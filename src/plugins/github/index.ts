import { Context, Schema, Time } from 'koishi'
import BasePlugin from '~/_boilerplate'
import { SubscriptionStore } from './subscribe'
import { applyWebhook } from './webhook'
import { GitHubHttp } from './http'
import { applyOAuth } from './oauth'
import { applyCommands, makeRepoStore } from './commands'
import { migrateRepoRename } from './rename'
import { HistoryStore } from './history'
import { ReplyHandler, parseReplyCommand, formatHelp } from './reply'
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
    const history = new HistoryStore(ctx, this.config.replyTimeout ?? Time.hour)

    applyOAuth(ctx, this.config, http)
    applyCommands(ctx, this.config, http, this.store, repoStore)

    applyWebhook(ctx, this.config, {
      getHook: async (hookId) => {
        const [row] = await ctx.database.get('github', [hookId])
        return row ? { name: row.name, secret: row.secret } : undefined
      },
      targets: (repo, event, action) => this.store.targets(repo, event, action),
      recordHistory: (ids, actions, body) => history.record(ids, actions, body),
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

    // ---- quick-reply interactions (quote a pushed message → act on the GitHub resource) ----
    const footer = this.config.replyFooter ?? ''

    // Pull the github user field only when the quoted message is in history (needs a token).
    ctx.before('attach-user', (session, fields) => {
      if (session.quote && history.get(session.quote.id)) fields.add('github')
    })

    ctx.middleware((session, next) => {
      if (!session.quote) return next()
      const entry = history.get(session.quote.id)
      if (!entry) return next()
      const body = session.stripped.content.trim()
      if (!body) return next() // empty reply (bare @bot / whitespace) — don't post an empty comment
      const { name, message } = parseReplyCommand(body)
      // Mark handled the moment we take over: our actions hit the GitHub API via ctx.http
      // (not session.send) and resolve to undefined on success — without this flag the
      // FallbackHandler would see no result + the QQ-prepended @bot and fire `chat`.
      if (name === 'help') {
        session._handled = true
        return formatHelp(Object.keys(entry.actions))
      }
      // Own-property check so inherited names (toString/constructor/...) miss instead
      // of resolving to a truthy Function and throwing on the `...params` spread.
      const params = Object.prototype.hasOwnProperty.call(entry.actions, name)
        ? (entry.actions as Record<string, any[]>)[name]
        : undefined
      if (!params) {
        // An explicit ".command" this message type doesn't support (e.g. .close on a push):
        // tell the user the available actions rather than silently dropping to the chat handler.
        if (body.startsWith('.')) {
          session._handled = true
          return `此消息不支持「.${name}」。\n` + formatHelp(Object.keys(entry.actions))
        }
        return next()
      }
      session._handled = true
      // Middleware sessions carry no static user fields (Observed<never>); the github
      // field is attached at runtime by the attach-user hook above. Match the codebase
      // idiom of `session.user as any` for reading such extended fields.
      const su = session.user as any
      const user = { id: su.id, github: su.github }
      // entry.body is the pre-cleaned original body (header line already excluded).
      const handler = new ReplyHandler(ctx, http, user, message, entry.body, footer)
      return (handler as any)[name](...params)
    })
  }
}
