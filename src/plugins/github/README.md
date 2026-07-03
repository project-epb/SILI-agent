# koishi-plugin-github

[![npm](https://img.shields.io/npm/v/koishi-plugin-github?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-github)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

将 GitHub 仓库事件推送到聊天频道，并支持**引用一条推送消息直接对相应资源进行操作**——评论、加 reaction、关闭、合并、回显链接等，无需离开聊天窗口。

## 特性

- 📥 **事件推送**：接收仓库 webhook，将 issue / PR / 评论 / push 等事件渲染成消息推送到订阅频道。
- 💬 **引用回复交互**：在时限内引用（quote）一条推送消息，即可对其对应的 GitHub 资源执行操作。
- 🔐 **OAuth 网页授权**：用户通过标准 OAuth Web Flow 绑定自己的 GitHub 账号；所有写操作以该用户身份执行，token 过期自动刷新。
- 🪝 **自助注册 webhook**：通过命令在仓库上创建 / 删除 webhook，无需手动到 GitHub 后台配置。
- ✅ **签名校验**：每次投递按 `X-Hub-Signature-256`（HMAC-SHA256）校验，拒绝伪造请求。
- ⚡ **即时响应**：收到 webhook 后立即返回 `200`，广播异步进行，避免触发 GitHub 的重投递；内置内存级去重防止重复推送。

## 安装

```bash
npm install koishi-plugin-github
```

依赖服务：`database`、`server`、`http`。请确保已加载数据库插件与 [`@koishijs/plugin-server`](https://server.koishi.chat/)，并且 server 配置了可公网访问的 `selfUrl`（webhook 与 OAuth 回调都需要外部可达）。

## 前置准备

1. 在 GitHub 创建一个 [OAuth App](https://github.com/settings/developers)。
2. 将 **Authorization callback URL** 设为 `<selfUrl><path>/authorize`（例如 `https://example.com/github/authorize`，`path` 见下方配置）。
3. 记下 App 的 **Client ID** 与 **Client Secret**，填入插件配置。

授权请求的 scope 为 `admin:repo_hook,repo`（创建 webhook 与读写仓库所需）。

## 配置

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `appId` | `string` | — | OAuth App 的 Client ID |
| `appSecret` | `string` | — | OAuth App 的 Client Secret |
| `path` | `string` | `/github` | webhook 与 OAuth 回调路由的基础路径 |
| `redirect` | `string` | 自动推导 | OAuth 回调地址；留空时由 `selfUrl + path + /authorize` 推导 |
| `messagePrefix` | `string` | `[GitHub] ` | 每条推送消息的前缀 |
| `replyFooter` | `string` | `''` | 机器人代发评论时追加的签名（会附在评论末尾） |
| `replyTimeout` | `number` (ms) | `3600000`（1 小时） | 引用回复的有效窗口，也是消息 → 操作映射的内存存活时间 |
| `bodyMaxLength` | `number` | `500` | 消息中 issue / PR / 评论正文的截断长度，`0` 表示不截断 |

> webhook 接收路由为 `<path>/webhook`，OAuth 回调路由为 `<path>/authorize`。

## 快速开始

命令前缀取决于你的机器人部署，下文一律省略前缀。

```
# 1. 绑定 GitHub 账号（返回一个授权链接，点击后在浏览器完成授权）
github.authorize

# 2. 在仓库上注册 webhook，并顺带订阅到当前频道
github.repos -a owner/repo -s
```

完成后，该仓库的事件就会推送到当前频道。之后其他频道也可以只订阅、无需重复注册：

```
github -a owner/repo      # 当前频道订阅（仓库须已注册过 webhook）
github -l                 # 查看当前频道订阅了哪些仓库
github -d owner/repo      # 取消订阅
```

## 引用回复交互

在 `replyTimeout` 窗口内，**引用（quote）机器人推送的某条消息**并发送以下内容，即可对该消息对应的 GitHub 资源操作：

| 输入 | 效果 |
|---|---|
| 直接输入文本 | 在对应 issue / PR 下发表评论（**不引用**原文，用于直接表态） |
| 直接发送 emoji 名 | 加 reaction（支持 `+1` `-1` `laugh` `confused` `heart` `hooray` `rocket` `eyes`） |
| `.reply <文本>` | **引用**原消息并评论（正文前带上 `> 原文`） |
| `.react <emoji>` | 加 reaction |
| `.link` | 回显该资源的链接 |
| `.close [文本]` | 关闭 issue / PR，可附一句评论 |
| `.base <分支>` | 修改 PR 的 base 分支 |
| `.merge [标题]` | 合并 PR（merge commit） |
| `.rebase [标题]` | 以 rebase 方式合并 PR |
| `.squash [标题]` | 以 squash 方式合并 PR |
| `.help` | 列出**当前这条消息**支持的快捷操作 |

不同事件支持的操作不同（例如 `.merge` 仅对 PR 有效）；对某条消息使用它不支持的操作时，会提示可用列表。所有写操作以引用者绑定的 GitHub 身份执行，未绑定时会引导其先授权。

## 命令参考

| 命令 | 说明 |
|---|---|
| `github.authorize`（别名 `github.auth`） | 通过 OAuth 绑定 GitHub 账号 |
| `github [repo]`（别名 `gh`） | 频道订阅管理：`-l` 列出、`-a` 订阅、`-d` 取消订阅 |
| `github.repos [repo]` | webhook 注册管理：无参数列出已注册仓库、`-a` 注册、`-d` 删除、`-s` 注册后顺带订阅当前频道 |
| `github.issue <title> [body] -r <repo>` | 新建一个 issue |
| `github.star <repo>` | star 一个仓库 |

> 频道订阅相关的 `-a` / `-d` 默认需要 authority 2。

## 支持的事件

`push`、`issues`、`issue_comment`、`pull_request`、`pull_request_review`、`pull_request_review_comment`、`commit_comment`、`create`、`delete`、`fork`、`milestone`、`star`。

机器人自身产生的评论（例如通过引用回复代发的评论）在被 webhook 推回时会自动去除签名，不会造成重复噪声。

## 工作原理

- **账号绑定**：`github.authorize` 生成带一次性 state 的授权链接；用户在浏览器授权后，回调路由用 code 换取 access / refresh token 并与其聊天账号关联。请求失败时呈现自带的结果页而非空白错误。
- **事件推送**：`github.repos -a` 调用 GitHub API 在仓库上创建 webhook 并记录其 secret；每次投递用该 secret 校验签名后，按订阅关系渲染并广播到相应频道。
- **引用回复**：广播时，插件把「消息 → 该事件支持的操作及对应 API 地址」的映射短暂保存在内存中（`replyTimeout`）；当用户引用某条消息时据此定位资源并执行操作。该映射在进程重启后清空。

## License

[MIT](./LICENSE)
