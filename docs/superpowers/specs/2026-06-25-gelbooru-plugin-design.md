# gelbooru 查询插件 设计

让 SILI 的 agent 能查 gelbooru 标签（验证 tag 存在/热度/autocomplete）和搜索 post（看真实 tag 组合作为写 prompt 参考），辅助 comfyui 画图。**移植自** `~/.claude/skills/gelbooru/gelbooru.py`（同构 koishi 插件，参照 comfyui 插件的模式）。

## 形态

独立插件 `src/plugins/gelbooru/`，与其它插件平级注册。命令注册为 **agent 工具**（`descriptionForAgents` + `hideForHuman`），agent 经命令系统调用。用 `ctx.http` 查 dapi。**只读查询，不下载、不发图。**

## 命令（agent 工具）

| 命令 | 作用 |
|---|---|
| `gelbooru.tags <query>` | tag 查询。默认 exact `name=` 精确查；`-p`/`--pattern` 把 query 当 SQL LIKE（自动包 `%query%`）做 autocomplete；`-l`/`--limit`（默认 20，上限 100）；`--orderby count`（按热度，autocomplete 时常用）。返回精简 `[{name, count, type}]`。 |
| `gelbooru.search <tags>` | post search（`tags` 是 gelbooru 查询语法，空格 AND、`-tag` 排除、`rating:general` 等）。`-l`/`--limit`（默认 10，上限 100）。返回精简 `[{id, score, rating, tags, sample_url}]`；**含黑名单标签的 post，sample_url 替换为 `[已过滤]`**（保留 tags/score）。 |

命令 description 写 skill/trigger 风格（英文，与 comfyui 一致）：tags=「验证/补全标签」，search=「看某标签真实组合/热门用法」。helpForAgents 写参数细节 + gelbooru 查询语法速查。

## client（移植 `gelbooru.py`）

`src/plugins/gelbooru/client.ts` —— `GelbooruClient`：
- 构造 `new GelbooruClient(http: HTTP, { apiKey, userId })`；http 是 `ctx.http`。
- **auth = query 参数**（不是 header）：每请求带 `api_key` + `user_id`。
- `BASE = 'https://gelbooru.com/index.php'`，UA `gelbooru-sili/0.1`。
- `lookupTags({ name?, names?, namePattern?, orderby?, order?, limit })` → GET `?page=dapi&s=tag&q=index&json=1&...` → `extractList(data, 'tag')`。
- `searchPosts(tags, { limit, pid })` → GET `?page=dapi&s=post&q=index&json=1&tags=...&limit=...&pid=...` → `extractList(data, 'post')`。
- `extractList(payload, key)`：`payload[key] ?? []`（dict 形态）或 payload 本身（array 形态）——移植 `_extract_list`（gelbooru json 有时 `{@attributes, post:[...]}`，有时裸 array）。**纯函数，单测。**
- 错误：401 → 凭据无效（清晰提示）；其它 HTTP 错误 → 通用错误串。用 `ctx.http.isError` 判断 status（同 comfyui client）。

## 标签过滤（去缩略图，保留 tags）

`src/plugins/gelbooru/filter.ts` 纯函数 `filterPostImages(posts, blacklist: string[]): posts`：每个 post 的 `tags`（空格分隔）拆词，与 blacklist（小写比较）求交，命中则把该 post 的 `sample_url` 置为 `'[已过滤: 含敏感标签]'`（保留 tags/score/id）。空 blacklist = no-op。**单测。**

`gelbooru.search` 的 action 里：`session.resolve(config.imageBlacklist)` 解析 Computed → 传 `filterPostImages`。

## Config

```ts
export interface Config {
  apiKey?: string
  userId?: string
  defaultTagsLimit?: number       // 默认 20
  defaultSearchLimit?: number     // 默认 10
  requestTimeoutMs?: number       // 默认 15000
  /** post.tags 命中任一词 → 该 post 去缩略图（保留 tags）。Computed 可按群。 */
  imageBlacklist?: Computed<string[]>
}
```

- **惰性无害**：无 `apiKey`/`userId` 时插件仍加载、命令仍注册，调用返回「未配置 gelbooru 凭据」提示（类比 comfyui no-backend）。
- 凭据从 `.env`（`GELBOORU_API_KEY` / `GELBOORU_USER_ID`），`src/index.ts` 接入；`imageBlacklist` 也在 `src/index.ts` 配（Computed 按群）。

## 文件

```
src/plugins/gelbooru/
├── index.tsx     插件入口：Config + 两命令注册 + client 装配（ctx.http.extend 或直接传 ctx.http）
├── client.ts     GelbooruClient（lookupTags/searchPosts/extractList）+ 错误分类
├── filter.ts     filterPostImages 纯函数
└── __tests__/    vitest：extractList（dict/array/缺失）、filterPostImages（命中去图/保留 tags/空 blacklist no-op）
```

`src/index.ts`：`ctx.plugin(PluginGelbooru, { apiKey: env.GELBOORU_API_KEY, userId: env.GELBOORU_USER_ID, imageBlacklist: ... })`。

## 测试

纯逻辑全单测：`extractList`（三种 payload 形态）、`filterPostImages`（命中/未命中/空/大小写）。client 网络层 + 命令层（index.tsx 因 koishi vitest 不可 import）靠 docker 集成验证。

## 验收

1. `npx vitest run src/plugins/gelbooru/__tests__` 全绿；`tsc` 无 gelbooru 错误。
2. 重启 core：启动日志加载 gelbooru 插件、命令注册无错误。
3. 配 `.env` 凭据后，`;chat 帮我查 fox_girl 相关标签` → agent 调 `gelbooru.tags`；`帮我看看 1girl,silver_hair 常配什么` → agent 调 `gelbooru.search`，敏感图被过滤。

## 不做（YAGNI）

- download / 发图 / comment / user / deleted endpoint。
- 分页 UI（agent 用 `--limit` + `--pid` 足够；search 命令本版只暴露 limit）。
