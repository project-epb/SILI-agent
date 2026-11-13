# SILI profile 设计

把启动代码从 `src/index.ts` 移走，按 **profile** 选择要装哪些适配器和插件。`v4` 是现有行为（NapCat/OneBot 时代），`v5` 是迁到 QQ 官方 bot 之后的版本，只装已经适配好的功能。

## 目标 / 非目标

- 目标：用一个开关切换 profile；`v4` 行为与现在完全一致；`v5` 能随适配进度逐个加插件。
- 非目标：同一进程同时跑两个 profile；改动 `v4` 里任何插件的行为；改数据库结构；适配 `v5` 暂不装的插件（各自独立处理）；`v5` 的部署形态（上线时再定，约束见下文）。
- 不同 profile 是**独立进程**，各连各的机器人。共用同一个 Mongo 时，定时任务、GitHub 推送会各触发一遍，这个问题不在本次范围。

## 选择方式

- 优先级：启动参数 `--profile=<name>`，其次环境变量 `SILI_PROFILE`，都没有则为 `v4`。
- profile 名必须在加载 `.env.*` **之前**读取：现有的 env 加载用 `override: true` 读入 `.env.production` / `.env.development` / `.env.local`，会覆盖 compose 传入的同名变量。`SILI_PROFILE` 不得写进这几个文件。
- 名字不在注册表里时直接报错并列出可选项（fail-fast）。

## 文件结构

```
src/index.ts              入口：读 profile 名 → loadEnv → 动态 import → createApp → install → start
src/bootstrap.ts          loadEnv()、createApp(profile)、进程级错误监听
src/profiles/index.ts     注册表 { v4, v5 }，值是 () => import(...)；迁移期再加 v4-migrate
src/profiles/types.ts     Profile 接口
src/profiles/v4.ts        现有 index.ts 的全部安装逻辑，只搬不改
src/profiles/v5.ts        新 profile
src/profiles/shared/      v4 与 v5 都装的插件的配置函数
```

- 注册表是静态映射，按名字取对应的 `import()`，不按字符串拼路径。动态 import 让 `v5` 不必加载 `v4` 的全部依赖（OneBot 适配器等）。

## Profile 接口

```ts
interface Profile {
  /** App 级选项：prefix、autoAssign、autoAuthorize 等，由各 profile 自定 */
  appOptions(env: NodeJS.ProcessEnv): Partial<App.Config>
  /** 安装适配器与插件 */
  install(app: App): void | Promise<void>
}
```

- `createApp` 负责所有 profile 共用的选项（`nickname`、`minSimilarity`、`delay`）、Server 和 Mongo，再合并 profile 的 `appOptions`。`autoAssign`、`autoAuthorize` 是 App 级选项，访问控制依赖它们，所以不能只开放 `prefix`。
- 入口保留 `logger('INIT')` 和 `app.start()` 之后的「🌈 SILI启动成功~」日志，部署流程以这行判断就绪。
- `bootstrap` 为所有 profile 注册进程级的 `unhandledRejection` / `uncaughtException` 监听：bun 下未处理的 rejection 会直接让进程退出，而 Koishi 只在 CLI 的 worker 进程里注册这个监听，本项目自己 `new App`，不走 worker。`ProcessErrorHandler` 里「私聊通知站长」的部分留在各 profile，`v4` 保持原样。

## v4：只搬不改

- 插件的注册顺序与现在**逐行一致**。前置中间件的先后取决于注册顺序（`FallbackHandler` 等依赖它），搬动代码、抽取 `shared/` 时都不能改变调用位置。
- 原 `index.ts` 里横跨分组的代码随所在分组一起搬：DingTalk 消息去重（在适配器分组里）、novelai 的命令补丁、dialogue 的两个 hotfix 钩子。
- `v4` 仍会在设置了 `QQBOT_APPID` 时装官方适配器。`v5` 运行期间，`v4` 的环境里不能有 `QQBOT_APPID`：同一个机器人的两条网关连接会互相抢。

## shared/

- 只抽 `v4`、`v5` 都装的插件的配置。
- 与 profile 相关的值由各 profile 作为参数传入，不能写死在 `shared/` 里。例如 ComfyUI 的 `allowedChannels` 现在写死了 `v4` 的群号和 QQ 号，在 `v5` 下会变成全部拒绝或全部放行。

## v5 首版内容

只装平台无关或已适配的部分，随适配进展增减。**Koishi 对缺失的依赖不报错，插件只会静默地不加载**，所以清单必须显式包含被依赖的服务。

**适配器**：只装 QQ 官方（`koishi-plugin-adapter-qq-crack`），使用适配器默认的 intents（包含入群申请等群事件所需的 `GROUP_MEMBER_EVENT`）。`v5` **不加载 OneBot 适配器**，也不含 villa 的前缀分支；其余适配器同样不装。

**装**
- 核心与通用：help、commands、switch、http、assets-s3、puppeteer（`HTMLService` 依赖它，进而 md、hljs、webshot、reboot、dbadmin、sticker 都依赖它）、silk（适配器发送语音需要）、admin、callme、echo、rate-limit、recall；父命令 `admin`、`tools`
- 业务：about、dice、hljs、markdown、ping、profile、queue、sticker、to-image、webshot
- LLM（含 Gelbooru）、GitHub
- 控制台：Console、Auth、Status、Logger、LlmDashboard、LlmAdmin
- 内部：HTMLService、FallbackHandler、SilentSwitch、PatchCallme、PiggybackService、DatabaseAdmin、Homo、Reboot、SensitiveFilter、Spawn
- 访问控制 spec 里的守卫、消息存储 `qqbot_message`、元数据表和 `qqbot-admin` 页面

**不装（依赖 OneBot）**：repeater、sili-name、mute、QQNT 表情回应、MgpGroupUtils、MinecraftConnect、FixQQSendLinks、version、Debug、GuildRequestFirewall、ProcessErrorHandler（通知部分）、Autowithdraw
**不装（被 `qqbot_message` 取代）**：MessagesLogger（文件日志）
**不装（用了合并转发）**：caniuse、pixiv、mediawiki
**不装（待重新设计）**：verify-fandom-user
**不装（能撤销迁移绑定）**：plugin-bind
**消息存储完成后再装**：who-asked（改读 `qqbot_message`）
**未决**：Dialogue 问答库、Analytics、Dataview、Explorer、Insight、Sandbox、ComfyUI、NovelAI、Broadcast、Schedule、ImageSearch、Basedata、ManosabaMemes、PowerUser、PluginMinecraft、Youdao

## 验证

- `tsc` 的报错集合与改动前一致（已知的 `ctx.plugin(...)` 噪音不变）。
- 写一个一次性脚本，导出程序化快照，对比 `v4` 改动前后：命令列表（含别名、权限）、`ctx.model.tables` 的字段、各事件的监听器数量、中间件顺序。本地日志只有 warn 以上级别，启动日志里没有插件清单，不能靠肉眼比对。
- 同一脚本对 `v5` 列出所有插件的状态，确认没有因缺少依赖而静默未加载的插件。
- `v5` 在没有 QQ 凭据时能启动；有凭据时能连上官方网关。
- `SILI_PROFILE` 为未知值时报错；compose 传入的 profile 不会被 `.env.*` 覆盖。

## 部署约束（v5 上线时处理）

`v5` 作为第二个容器运行时要解决：`container_name` 和网络别名 `core.sili.local` 冲突；`data/` 目录共用；`sili_node_modules` 卷共用，而 `scripts/docker-entrypoint.sh` 每次启动都会跑 `bun install`，两个容器同时启动会并发写同一个卷；两个容器挂载同一个 `./.env`。

## 文档

改完同步更新 `CLAUDE.md`：「加新功能 = 在 `src/index.ts` 里注册」改为说明 profile 与注册位置，并加上 `SILI_PROFILE` 的用法。

## 相关

- 访问控制与消息存储见 `2026-11-13-v5-access-control-design.md`；迁移和 `v4-migrate` 见 `2026-11-13-onebot-to-qqbot-migration-design.md`。
