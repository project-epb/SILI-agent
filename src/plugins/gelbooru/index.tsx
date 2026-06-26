import { Context } from 'koishi'
import type { Computed } from 'koishi'

import BasePlugin from '~/_boilerplate'

import {
  GelbooruClient,
  GelbooruError,
  type GelbooruPost,
  type GelbooruTag,
  USER_AGENT,
} from './client'
import { filterPostImages } from './filter'

export interface Config {
  apiKey?: string
  userId?: string
  /** Default limit for `gelbooru.tags`. Default 20. */
  defaultTagsLimit?: number
  /** Default limit for `gelbooru.search`. Default 10. */
  defaultSearchLimit?: number
  /** Per-request timeout (ms). Default 15000. */
  requestTimeoutMs?: number
  /**
   * A post whose tags hit any of these words has its sample_url replaced with a
   * "filtered" placeholder (tags/score/id are kept). Computed → per-channel/user.
   */
  imageBlacklist?: Computed<string[]>
}

const NO_CREDS_MSG =
  'Gelbooru credentials are not configured (missing api_key / user_id). Tell the user this lookup tool is unavailable; do not retry.'

const TAGS_LIMIT_MAX = 100
const SEARCH_LIMIT_MAX = 100

export default class PluginGelbooru extends BasePlugin<Config> {
  static inject = { http: { required: true } }

  private readonly client: GelbooruClient | null

  constructor(ctx: Context, config: Config) {
    super(ctx, config, 'gelbooru')

    // Lazily harmless: only wire a client when credentials exist. Without them
    // the commands still register (agent catalog stays consistent) but return a
    // "not configured" notice instead of making any network call.
    if (config.apiKey && config.userId) {
      const http = ctx.http.extend({
        timeout: config.requestTimeoutMs ?? 15_000,
        headers: { 'User-Agent': USER_AGENT },
      })
      this.client = new GelbooruClient(http, {
        apiKey: config.apiKey,
        userId: config.userId,
      })
    } else {
      this.client = null
    }

    this.logger.info(
      'gelbooru: lookup tool %s',
      this.client ? 'ready' : '(no credentials configured)'
    )

    this.#registerCommands()
  }

  #registerCommands() {
    const ctx = this.ctx

    ctx
      .command('gelbooru', 'Gelbooru 标签/图片查询工具', {
        descriptionForAgents:
          'Read-only Gelbooru lookup toolbox for grounding image-generation prompts in real danbooru-style tags. ' +
          'Use the subcommands `gelbooru.tags` (verify/autocomplete a tag) and `gelbooru.search` (see real tag combinations on existing posts).',
      })
      .action(({ session }) =>
        session?.execute({ name: 'gelbooru', options: { help: true } })
      )

    ctx
      .command('gelbooru.tags <query:string>', '查询 Gelbooru 标签', {
        descriptionForAgents:
          'Use this command to verify that a Gelbooru tag exists, check its popularity (post count), or autocomplete a partial tag, before putting it into an image-generation prompt. ' +
          'By default it does an EXACT name match; pass `--pattern` to do a fuzzy autocomplete search.',
        helpForAgents:
          'Returns a JSON array of `{name, count, type}` (count = number of posts using the tag; higher = more reliable/common).\n' +
          '### ARGUMENTS & OPTIONS:\n' +
          '- `query`: the tag (or fragment) to look up. Gelbooru tags use underscores, not spaces (e.g. `silver_hair`, `fox_girl`).\n' +
          '- `--pattern` / `-p`: treat `query` as a fuzzy SQL-LIKE fragment (it is auto-wrapped in `%...%`). Use this for autocomplete / discovery when you are unsure of the exact tag. Results are ordered by `count` (most popular first).\n' +
          '- `--limit` / `-l`: max tags to return (1-100, default ' +
          String(this.config.defaultTagsLimit ?? 20) +
          ').\n' +
          '### TIPS:\n' +
          '- Exact mode (no `--pattern`) returns 0 results if the tag does not exist verbatim — that itself is a useful signal that the tag is wrong.\n' +
          '- Prefer high-count tags; very low counts often mean typos or fringe tags that models will not have learned.',
      })
      .option('pattern', '-p 把 query 当作 SQL LIKE 片段做模糊补全（自动包 %query%）')
      .option('limit', '-l <limit:posint> 返回数量（1-100，默认 20）')
      .action((argv, query) => this.#handleTags(argv, query))

    ctx
      .command('gelbooru.search <tags:text>', '按标签搜索 Gelbooru 帖子', {
        descriptionForAgents:
          'Use this command to see how a given set of tags is actually combined on real Gelbooru posts — great for discovering which companion tags, ratings, and styles co-occur with a concept before you write an image-generation prompt. ' +
          'This is a READ-ONLY lookup: it never downloads or sends images.',
        helpForAgents:
          'Returns a JSON array of `{id, score, rating, tags, sample_url}` (tags = the full space-separated tag string of that post; the richest signal for prompt-building).\n' +
          '### ARGUMENTS & OPTIONS:\n' +
          '- `tags`: a Gelbooru tag query. Space = AND, `-tag` excludes a tag, and meta-tags are supported, e.g.:\n' +
          '    `1girl silver_hair rating:general`\n' +
          '    `cat_ears sort:score`            (sort by score)\n' +
          '    `scenery -1girl`                 (exclude a tag)\n' +
          '    `score:>=100 width:>1920`        (numeric meta-tags)\n' +
          '- `--limit` / `-l`: max posts to return (1-100, default ' +
          String(this.config.defaultSearchLimit ?? 10) +
          ').\n' +
          '### NOTES:\n' +
          '- Some posts may come back with `sample_url` replaced by a filtered placeholder; their `tags`/`score` are still usable for prompt research.\n' +
          '- Mine the `tags` field of high-`score` posts to learn the canonical companion tags for a concept.',
      })
      .option('limit', '-l <limit:posint> 返回数量（1-100，默认 10）')
      .action((argv, tags) => this.#handleSearch(argv, tags))
  }

  async #handleTags(argv: any, query: string): Promise<string> {
    if (!this.client) return NO_CREDS_MSG
    if (!query || !query.trim()) return 'missing required arg: query'

    const { options } = argv
    const limit = clampLimit(
      options.limit ?? this.config.defaultTagsLimit ?? 20,
      TAGS_LIMIT_MAX
    )

    try {
      let tags: GelbooruTag[]
      if (options.pattern) {
        tags = await this.client.lookupTags({
          namePattern: `%${query.trim()}%`,
          orderby: 'count',
          limit,
        })
      } else {
        tags = await this.client.lookupTags({ name: query.trim(), limit })
      }
      const slim = tags.map((t) => ({
        name: t.name,
        count: t.count,
        type: t.type,
      }))
      return JSON.stringify(slim, null, 2)
    } catch (e) {
      return this.#formatError(e)
    }
  }

  async #handleSearch(argv: any, tags: string): Promise<string> {
    if (!this.client) return NO_CREDS_MSG
    if (!tags || !tags.trim()) return 'missing required arg: tags'

    const { session, options } = argv
    const limit = clampLimit(
      options.limit ?? this.config.defaultSearchLimit ?? 10,
      SEARCH_LIMIT_MAX
    )

    try {
      const posts = await this.client.searchPosts(tags.trim(), { limit })
      const blacklist = this.config.imageBlacklist
        ? session.resolve(this.config.imageBlacklist)
        : []
      filterPostImages(posts, blacklist ?? [])
      const slim = posts.map((p: GelbooruPost) => ({
        id: p.id,
        score: p.score,
        rating: p.rating,
        tags: p.tags,
        sample_url: p.sample_url,
      }))
      return JSON.stringify(slim, null, 2)
    } catch (e) {
      return this.#formatError(e)
    }
  }

  #formatError(e: unknown): string {
    if (e instanceof GelbooruError) {
      return `gelbooru lookup failed (${e.type}): ${e.message}`
    }
    this.logger.warn('gelbooru lookup unexpected error: %o', e)
    return `gelbooru lookup failed: ${(e as Error)?.message ?? e}`
  }
}

function clampLimit(value: number, max: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(Math.floor(value), max))
}
