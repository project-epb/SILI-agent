# SILI profile 设计

把启动代码从 `src/index.ts` 移走，按 **profile** 选择要装哪些适配器和插件。`v4` 是现有行为（NapCat/OneBot 时代）。`v5` 是把 OneBot 换成 QQ 官方 bot 的版本：在 Koishi 里两者是不同的平台，最终目标是 `v4` 的插件在 `v5` 里全部装上，分阶段推进。

## 目标 / 非目标

- 目标：用一个开关切换 profile；`v4` 行为与现在完全一致；`v5` 按阶段装回插件。
- 非目标：同时运行多个 profile；改动 `v4` 里任何插件的行为；改数据库结构；阶段三里各个插件的适配（各自独立设计）。
- **同一时间只运行一个 profile**：`v4` 用于回退，`v5` 是切换后的目标。切换就是改 profile 并重启，部署形态不变。

## 选择方式

- 优先级：启动参数 `--profile=<name>`，其次环境变量 `SILI_PROFILE`，都没有则为 `v4`。
- profile 名必须在加载 `.env.*` **之前**读取：现有的 env 加载用 `override: true` 读入 `.env.production` / `.env.development` / `.env.local`，会覆盖 compose 传入的同名变量。`SILI_PROFILE` 不得写进这几个文件。
- 名字不在注册表里时直接报错并列出可选项（fail-fast）。

## 文件结构

```
src/index.ts              入口：读 profile 名 → loadEnv → 动态 import → createApp → install → start
src/bootstrap.ts          loadEnv()、createApp(profile)、进程级错误监听
src/profiles/index.ts     注册表 { v4, v5 }，值是 () => import(...)
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
- 回退是安全的：`v5` 期间写进库里的内容（`qqbot_*` 表、`qq` 平台的绑定与频道）`v4` 不读，老用户的 OneBot 绑定始终保留。

## shared/

- 只抽 `v4`、`v5` 都装的插件的配置。
- 与 profile 相关的值由各 profile 作为参数传入，不能写死在 `shared/` 里。例如 ComfyUI 的 `allowedChannels` 现在写死了 `v4` 的群号和 QQ 号，在 `v5` 下会变成全部拒绝或全部放行。

## v5 的内容

**Koishi 对缺失的依赖不报错，插件只会静默地不加载**，所以每个阶段的清单都必须显式包含被依赖的服务（例如 puppeteer：`HTMLService` 依赖它，md、hljs、webshot、reboot、dbadmin、sticker 又依赖 `HTMLService`）。

**适配器**（从阶段一起）：QQ 官方（`koishi-plugin-adapter-qq-crack`，使用适配器默认的 intents，包含入群申请等群事件所需的 `GROUP_MEMBER_EVENT`），以及 `v4` 里除 OneBot 以外的全部适配器（Discord、钉钉、KOOK、飞书、Minecraft），它们与这次迁移无关，照常服务。不含 villa 的前缀分支。

**迁移期的 OneBot**：设置了 `ONEBOT_SELFID` 时额外装 OneBot 适配器，**只用于接收 `bind` 的绑定码**，其余消息一概不处理（见迁移 spec 与访问控制 spec）。迁移期结束删除该变量，OneBot 不再加载，不需要改代码。

### 阶段一：最小集合与频道管理器

- 核心与通用：help、commands、switch、http、assets-s3、puppeteer、silk（适配器发送语音需要）、admin、bind（用户迁移与跨平台绑定）、callme、echo、rate-limit、recall；父命令 `admin`、`tools`
- 业务：about、dice、hljs、markdown、ping、profile、queue、sticker、to-image、webshot
- LLM（含 Gelbooru）、GitHub
- 控制台：Console、Auth、Status、Logger、LlmDashboard、LlmAdmin
- 内部：HTMLService、FallbackHandler、SilentSwitch、PatchCallme、PiggybackService、DatabaseAdmin、Homo、Reboot、SensitiveFilter、Spawn
- 访问控制 spec 的全部内容：守卫、消息存储 `qqbot_message`、元数据表、`qqbot-admin` 页面

### 阶段二：频道管理器完成后

装回所有**不依赖 OneBot 专属 API** 的插件，包括 Dialogue 问答库、MessagesLogger（其他平台的文件日志；`qq` 平台由 `qqbot_message` 记录）、控制台其余插件（Analytics、Dataview、Explorer、Insight、Sandbox）、ComfyUI、NovelAI、Broadcast、Schedule、ImageSearch、Basedata、ManosabaMemes、PowerUser、PluginMinecraft。

其中在 `qq` 平台上还不能正常工作的（caniuse、pixiv、mediawiki 用了官方 bot 不支持的合并转发），同样装上，但先只对 `qq` 平台屏蔽，其他平台照常使用。

### 阶段三：逐个适配

依赖 OneBot 专属 API，或在 `qq` 平台上需要改写的部分，逐个决定适配、改写还是移除：

- who-asked（`qq` 平台改读 `qqbot_message`）、LLM 的 `read_channel_history`（`qq` 平台改读 `qqbot_message`）
- caniuse、pixiv、mediawiki 在 `qq` 平台上的合并转发替代
- verify-fandom-user（官方 bot 拿不到 QQ 号，需要重新设计）
- MgpGroupUtils（群管理改用禁言）、GuildRequestFirewall（改用官方的入群申请接口）
- repeater、sili-name、mute、QQNT 表情回应、MinecraftConnect、version、Debug、FixQQSendLinks、Autowithdraw、ProcessErrorHandler 的通知部分

生产从 `v4` 切到 `v5` 的时机由用户决定，最早在阶段二完成后。

## 验证

- `tsc` 的报错集合与改动前一致（已知的 `ctx.plugin(...)` 噪音不变）。
- 写一个一次性脚本，导出程序化快照，对比 `v4` 改动前后：命令列表（含别名、权限）、`ctx.model.tables` 的字段、各事件的监听器数量、中间件顺序。本地日志只有 warn 以上级别，启动日志里没有插件清单，不能靠肉眼比对。
- 同一脚本对 `v5` 列出所有插件的状态，确认没有因缺少依赖而静默未加载的插件。
- `v5` 在没有 QQ 凭据时能启动；有凭据时能连上官方网关。
- `v5` 设置 `ONEBOT_SELFID` 时，OneBot 群里除迁移码以外的消息不触发任何功能、不建用户、不入库。
- `SILI_PROFILE` 为未知值时报错；compose 传入的 profile 不会被 `.env.*` 覆盖。

## 文档

改完同步更新 `CLAUDE.md`：「加新功能 = 在 `src/index.ts` 里注册」改为说明 profile 与注册位置，并加上 `SILI_PROFILE` 的用法。

## 相关

- 访问控制与消息存储见 `2026-11-13-v5-access-control-design.md`；迁移见 `2026-11-13-onebot-to-qqbot-migration-design.md`。
