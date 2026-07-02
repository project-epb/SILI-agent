import { Context, Random } from 'koishi'
import type { Config } from './types'
import type { GitHubHttp } from './http'
import type { SubscriptionStore } from './subscribe'

export const REPO_RE = /^[\w.-]+\/[\w.-]+$/

/** Reply strings — verbatim from the old plugin's locales/zh-CN.json. Functions interpolate the repo name. */
export const MSG = {
  followLink: '请点击下面的链接继续操作：',
  listEmpty: '当前没有订阅的仓库。',
  privateContext: '当前不是群聊上下文。',
  repoExpected: '请输入仓库名。',
  repoInvalid: '请输入正确的仓库名。',
  reposEmpty: '当前没有监听的仓库。',
  subAddUnchanged: (n: string) => `已经在当前频道订阅过仓库 ${n}。`,
  subAddSucceeded: '添加订阅成功！',
  subDeleteUnchanged: (n: string) => `尚未在当前频道订阅过仓库 ${n}。`,
  subDeleteSucceeded: '移除订阅成功！',
  subUnknown: (n: string) => `尚未添加过仓库 ${n}。发送空行或句号以立即添加并订阅该仓库。`,
  repoAddUnchanged: (n: string) => `已经添加过仓库 ${n}。`,
  repoAddSucceeded: '添加仓库成功！',
  repoAddFailed: '由于未知原因添加仓库失败。',
  repoNotFound: '仓库不存在或您无权访问。',
  repoDeleteUnchanged: (n: string) => `尚未添加过仓库 ${n}。`,
  repoDeleteSucceeded: '移除仓库成功！',
} as const

/** Pure: the -l list reply. */
export function resolveListReply(webhooks: Record<string, unknown> | undefined): string {
  const names = Object.keys(webhooks ?? {})
  return names.length ? names.sort().join('\n') : MSG.listEmpty
}

/** Pure: the no-option github.repos reply (list all registered repos). */
export function resolveReposListReply(names: string[]): string {
  return names.length ? names.join('\n') : MSG.reposEmpty
}

/** Pure: map a GitHub webhook-create error status to a reply key. */
export function mapWebhookError(status: number | undefined): 'notFound' | 'failed' {
  return status === 404 ? 'notFound' : 'failed'
}

/** Minimal wrapper over the `github` table (hook registry). */
export interface RepoStore {
  has(name: string): Promise<boolean>
  get(name: string): Promise<{ id: number; secret: string } | undefined>
  create(row: { id: number; name: string; secret: string }): Promise<void>
  remove(name: string): Promise<void>
  list(): Promise<string[]>
}

export function makeRepoStore(ctx: Context): RepoStore {
  return {
    async has(name) {
      return (await ctx.database.get('github', { name: [name] })).length > 0
    },
    async get(name) {
      const [row] = await ctx.database.get('github', { name: [name] })
      return row ? { id: row.id, secret: row.secret } : undefined
    },
    async create(row) {
      await ctx.database.create('github', row)
    },
    async remove(name) {
      await ctx.database.remove('github', { name: [name] })
    },
    async list() {
      return (await ctx.database.get('github', {})).map((r) => r.name)
    },
  }
}

/** Register github/gh + github.repos. (github.repos body is added in Task 4.) */
export function applyCommands(
  ctx: Context,
  config: Config,
  http: GitHubHttp,
  store: SubscriptionStore,
  repoStore: RepoStore
): void {
  const hidden = (session: any) => session.isDirect

  // ---- github [name] / gh : channel subscription management ----
  ctx
    .command('github [name]')
    .alias('gh')
    .channelFields(['github'])
    .option('list', '-l', { hidden })
    .option('add', '-a', { hidden, authority: 2 })
    .option('delete', '-d', { hidden, authority: 2 })
    .action(async ({ session, options }, name) => {
      const s = session!
      if (options!.list) {
        if (!s.channel) return MSG.privateContext
        return resolveListReply(s.channel.github.webhooks)
      }
      if (options!.add || options!.delete) {
        if (!s.channel) return MSG.privateContext
        if (!name) return MSG.repoExpected
        if (!REPO_RE.test(name)) return MSG.repoInvalid
        const repo = name.toLowerCase()
        const webhooks = s.channel.github.webhooks

        if (options!.delete) {
          if (!(repo in webhooks)) return MSG.subDeleteUnchanged(repo)
          delete webhooks[repo]
          await s.channel.$update()
          store.unsubscribe(repo, s.cid)
          return MSG.subDeleteSucceeded
        }

        // -a (subscribe)
        if (repo in webhooks) return MSG.subAddUnchanged(repo)
        if (!(await repoStore.has(repo))) {
          // Not registered yet: offer the one-shot "send empty line to add" flow.
          await s.send(MSG.subUnknown(repo))
          const reply = await s.prompt(config.replyTimeout ?? 60000)
          if (reply !== undefined && ['', '.', '。'].includes(reply.trim())) {
            // Chain into github.repos --add --subscribe (creates hook AND subscribes).
            return s.execute(
              { name: 'github.repos', args: [repo], options: { add: true, subscribe: true } },
              true
            )
          }
          return
        }
        webhooks[repo] = {}
        await s.channel.$update()
        store.subscribe(repo, s.cid, {})
        return MSG.subAddSucceeded
      }
      return s.execute('help github')
    })

  // github.repos is registered in Task 4 (same applyCommands function).
  applyReposCommand(ctx, config, http, store, repoStore)
}

/** github.repos [name] — manage the global webhook registry (-a create / -d delete / -s also-subscribe). */
function applyReposCommand(
  ctx: Context,
  config: Config,
  http: GitHubHttp,
  store: SubscriptionStore,
  repoStore: RepoStore
): void {
  const path = (config.path ?? '/github').replace(/\/$/, '')
  const callbackUrl = () => ctx.server.config.selfUrl + path + '/webhook'

  ctx
    .command('github.repos [name]')
    .userFields(['id', 'github'])
    .option('add', '-a')
    .option('delete', '-d')
    .option('subscribe', '-s')
    .action(async ({ session, options }, name) => {
      const s = session!
      if (!options!.add && !options!.delete) {
        return resolveReposListReply(await repoStore.list())
      }
      // shared guards for -a / -d
      if (!name) return MSG.repoExpected
      if (!REPO_RE.test(name)) return MSG.repoInvalid
      if (!s.user!.github?.accessToken) {
        // 'github.require-auth' in the old locale.
        await s.send('要使用此功能，请对机器人进行授权。输入你的 GitHub 用户名。')
        return s.execute({ name: 'github.authorize' })
      }
      const repo = name.toLowerCase()
      const user = { id: s.user!.id, github: s.user!.github }

      if (options!.add) {
        if (await repoStore.has(repo)) return MSG.repoAddUnchanged(repo)
        const secret = Random.id()
        let data: { id: number }
        try {
          data = await http.createWebhook(user, repo, { secret, callbackUrl: callbackUrl() })
        } catch (e: any) {
          const key = mapWebhookError(e?.response?.status)
          if (key === 'notFound') return MSG.repoNotFound
          ctx.logger('github').warn(e)
          return MSG.repoAddFailed
        }
        await repoStore.create({ name: repo, id: data.id, secret })
        if (!options!.subscribe) return MSG.repoAddSucceeded
        // -s: chain into channel subscribe (github --add)
        return s.execute({ name: 'github', args: [repo], options: { add: true } }, true)
      }

      // -d (delete webhook globally)
      const row = await repoStore.get(repo)
      if (!row) return MSG.repoDeleteUnchanged(repo)
      await http.deleteWebhook(user, repo, row.id) // swallows 404 internally
      // remove the repo key from every channel's webhooks + drop the whole-repo subscription
      const channels = await ctx.database.get('channel', {}, ['id', 'platform', 'github'])
      await ctx.database.upsert(
        'channel',
        channels
          .filter(({ github }) => github?.webhooks?.[repo])
          .map((c) => {
            delete c.github.webhooks[repo]
            return c
          })
      )
      store.unsubscribe(repo)
      await repoStore.remove(repo)
      return MSG.repoDeleteSucceeded
    })
}
