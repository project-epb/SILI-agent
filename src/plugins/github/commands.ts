import { Context, Random } from 'koishi'
import type { Config } from './types'
import type { GitHubHttp } from './http'
import type { SubscriptionStore } from './subscribe'

export const REPO_RE = /^[\w.-]+\/[\w.-]+$/

/** Reply strings. Functions interpolate the repo name. Replies about subscriptions must say whether
 * they concern the current channel or the global registry: the bot reads these to decide what to run. */
export const MSG = {
  listEmpty: '当前频道没有订阅任何仓库。',
  privateContext: '当前不是群聊上下文。',
  repoExpected: '请输入仓库名。',
  repoInvalid: '请输入正确的仓库名。',
  requireAuth: '要使用此功能，请先对机器人进行授权。',
  reposEmpty: '全局注册表中没有仓库。',
  subAddUnchanged: (n: string) => `已经在当前频道订阅过仓库 ${n}。`,
  subAddSucceeded: '添加订阅成功！',
  subDeleteUnchanged: (n: string) => `尚未在当前频道订阅过仓库 ${n}。`,
  subDeleteSucceeded: '移除订阅成功！',
  subUnknown: (n: string) => `尚未添加过仓库 ${n}。发送空行或句号以立即添加并订阅该仓库。`,
  repoAddUnchanged: (n: string) => `已经添加过仓库 ${n}。`,
  repoAddSucceeded: '添加仓库成功！',
  repoAddFailed: '由于未知原因添加仓库失败。',
  repoNotFound: '仓库不存在或您无权访问。',
  forbidden: '第三方访问受限，请尝试授权此应用。\nhttps://docs.github.com/articles/restricting-access-to-your-organization-s-data/',
  repoDeleteUnchanged: (n: string) => `尚未添加过仓库 ${n}。`,
  repoDeleteSucceeded: '已删除该仓库的 webhook，并移除了所有频道对它的订阅。',
  listHeader: '当前频道订阅的仓库：',
  reposHeader: '全局注册表中的仓库（所有频道共用，不代表当前频道已订阅）：',
  repoDeleteFailed: '由于未知原因移除仓库失败。',
} as const

/** Pure: the -l list reply. */
export function resolveListReply(webhooks: Record<string, unknown> | undefined): string {
  const names = Object.keys(webhooks ?? {})
  return names.length ? [MSG.listHeader, ...names.sort()].join('\n') : MSG.listEmpty
}

/** Pure: the no-option github.registry reply (list all registered repos). */
export function resolveReposListReply(names: string[]): string {
  return names.length ? [MSG.reposHeader, ...names].join('\n') : MSG.reposEmpty
}

/** Pure: map a GitHub webhook-create error status to a reply key. */
export function mapWebhookError(status: number | undefined): 'notFound' | 'forbidden' | 'failed' {
  if (status === 404) return 'notFound'
  if (status === 403) return 'forbidden'
  return 'failed'
}

/** Pure: a human-readable suffix from a Quester/GitHub error. Prefers HTTP status + upstream
 * message; for a network-layer failure (no HTTP response, e.g. `fetch failed`) surfaces the
 * underlying cause code/message. Never returns the raw error `message` — undici embeds the
 * request URL there, which can carry secrets. */
export function describeHttpError(e: any): string {
  const status = e?.response?.status
  const message = e?.response?.data?.message
  if (status && message) return `HTTP ${status}: ${message}`
  if (status) return `HTTP ${status}`
  const cause = e?.cause
  if (cause?.code) return String(cause.code)
  if (cause?.message) return String(cause.message)
  return ''
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

/** Register github/gh, github.subscribe, github.registry, github.issue and github.star. */
export function applyCommands(
  ctx: Context,
  config: Config,
  http: GitHubHttp,
  store: SubscriptionStore,
  repoStore: RepoStore
): void {
  const hidden = (session: any) => session.isDirect

  // `github` / `gh` is only a namespace: it shows help. Channel subscription lives in
  // `github.subscribe`, the global webhook registry in `github.registry`. Do not put
  // subscribe options back on the parent: mixing "this channel" and "every channel"
  // under one command name made the bot delete other channels' subscriptions.
  ctx
    .command('github', 'GitHub 仓库事件推送与操作', { featLevel: 0 })
    .alias('gh')
    .action(({ session }) => session!.execute('help github'))

  ctx
    .command('github.subscribe [name]', '管理当前频道订阅的仓库（只影响本频道）')
    .channelFields(['github'])
    .option('list', '-l 列出当前频道订阅的仓库', { hidden })
    .option('add', '-a 当前频道订阅仓库（仓库须已在全局注册表中）', { hidden, authority: 2 })
    .option('delete', '-d 当前频道取消订阅仓库（不影响其他频道）', { hidden, authority: 2 })
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
            // Chain into github.registry --add --subscribe (creates hook AND subscribes).
            return s.execute(
              { name: 'github.registry', args: [repo], options: { add: true, subscribe: true } },
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
      return s.execute('help github.subscribe')
    })

  applyRegistryCommand(ctx, config, http, store, repoStore)
  applyIssueStarCommands(ctx, http)
}

/** github.issue / github.star — direct authed actions (1:1 old plugin). */
function applyIssueStarCommands(ctx: Context, http: GitHubHttp): void {
  const requireAuth = async (s: any) => {
    await s.send(MSG.requireAuth)
    return s.execute({ name: 'github.authorize' })
  }

  ctx
    .command('github.issue [title] [body:text]')
    .userFields(['id', 'github'])
    .option('repo', '-r [repo:string]')
    .action(async ({ session, options }, title, body) => {
      const s = session!
      if (!options!.repo) return MSG.repoExpected
      if (!REPO_RE.test(options!.repo)) return MSG.repoInvalid
      if (!s.user!.github?.accessToken) return requireAuth(s)
      const user = { id: s.user!.id, github: s.user!.github }
      try {
        await http.request(user, 'POST', `https://api.github.com/repos/${options!.repo}/issues`, { title, body })
      } catch (e: any) {
        ctx.logger('github').warn(e)
        const detail = describeHttpError(e)
        return detail ? `创建 issue 失败：${detail}` : '创建 issue 失败。'
      }
      return '已创建 issue。'
    })

  ctx
    .command('github.star [name]')
    .userFields(['id', 'github'])
    .action(async ({ session }, name) => {
      const s = session!
      if (!name) return MSG.repoExpected
      if (!REPO_RE.test(name)) return MSG.repoInvalid
      if (!s.user!.github?.accessToken) return requireAuth(s)
      const user = { id: s.user!.id, github: s.user!.github }
      try {
        await http.request(user, 'PUT', `https://api.github.com/user/starred/${name}`)
      } catch (e: any) {
        ctx.logger('github').warn(e)
        const detail = describeHttpError(e)
        return detail ? `star 失败：${detail}` : 'star 失败。'
      }
      return `已 star ${name}。`
    })
}

/** github.registry [name] — the global webhook registry shared by every channel. */
function applyRegistryCommand(
  ctx: Context,
  config: Config,
  http: GitHubHttp,
  store: SubscriptionStore,
  repoStore: RepoStore
): void {
  const path = (config.path ?? '/github').replace(/\/$/, '')
  const callbackUrl = () => ctx.server.config.selfUrl + path + '/webhook'

  ctx
    .command('github.registry [name]', '管理全局仓库注册表（webhook），影响所有频道；不带选项时列出已注册仓库')
    .userFields(['id', 'github'])
    .option('add', '-a 在仓库上注册 webhook（需要已授权的 GitHub 账号）')
    .option('delete', '-d 删除 webhook，并移除所有频道对该仓库的订阅')
    .option('subscribe', '-s 与 -a 同用：注册后让当前频道订阅该仓库')
    .action(async ({ session, options }, name) => {
      const s = session!
      if (!options!.add && !options!.delete) {
        return resolveReposListReply(await repoStore.list())
      }
      // shared guards for -a / -d
      if (!name) return MSG.repoExpected
      if (!REPO_RE.test(name)) return MSG.repoInvalid
      if (!s.user!.github?.accessToken) {
        // Reworded from the old 'github.require-auth' string: the old text said "enter your
        // GitHub username", but the flow is now link-based OAuth (no username entry).
        await s.send(MSG.requireAuth)
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
          if (key === 'forbidden') return MSG.forbidden
          ctx.logger('github').warn(e)
          const detail = describeHttpError(e)
          return detail ? `添加仓库失败：${detail}` : MSG.repoAddFailed
        }
        await repoStore.create({ name: repo, id: data.id, secret })
        if (!options!.subscribe) return MSG.repoAddSucceeded
        // -s: chain into channel subscribe
        return s.execute({ name: 'github.subscribe', args: [repo], options: { add: true } }, true)
      }

      // -d (delete webhook globally)
      const row = await repoStore.get(repo)
      if (!row) return MSG.repoDeleteUnchanged(repo)
      try {
        await http.deleteWebhook(user, repo, row.id) // swallows 404 internally
      } catch (e: any) {
        ctx.logger('github').warn(e)
        const detail = describeHttpError(e)
        return detail ? `移除仓库失败：${detail}` : MSG.repoDeleteFailed
      }
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
