# SILI profile 设计

把启动代码从 `src/index.ts` 移走，按 **profile** 选择要装哪些适配器和插件。`v4` 是现有行为（NapCat/OneBot 时代），`v5` 是迁到 QQ 官方 bot 之后的版本，只装已经适配好的功能。

## 目标 / 非目标

- 目标：用一个开关切换 profile；`v4` 行为与现在完全一致；`v5` 能随适配进度逐个加插件。
- 非目标：同一进程同时跑两个 profile；改动 `v4` 里任何插件的行为；改数据库结构；适配 `v5` 暂不装的插件（各自独立处理）。
- 两个 profile 是**两个独立进程**，各连各的机器人。共用同一个 Mongo 时定时任务、GitHub 推送会各触发一遍，这个问题不在本次范围。

## 选择方式

`SILI_PROFILE` 环境变量；其次启动参数 `--profile=<name>`；都没有则为 `v4`。名字不在已知列表里直接报错并列出可选项（fail-fast）。

## 文件结构

```
src/index.ts              入口：加载 .env → 解析 profile 名 → 动态 import → 创建 app → 安装 → 启动
src/bootstrap.ts          loadEnv()、createApp(profile)（App 选项、Server、Mongo）
src/profiles/index.ts     已知 profile 注册表 { v4, v5 }，值是 () => import(...)
src/profiles/types.ts     Profile 接口
src/profiles/v4.ts        现有 index.ts 的全部插件安装逻辑，只搬不改
src/profiles/v5.ts        新 profile
src/profiles/shared/      v4 与 v5 都装的插件的配置块（LLM、ComfyUI、Gelbooru、GitHub、assets-s3 等）
```

- `Profile` 接口：`prefix(ctx)`（命令前缀，各 profile 自己定）和 `install(app)`（装适配器与插件）。
- 注册表用静态映射而不是按字符串拼路径 import。
- `.env` 必须先于 profile 模块加载（`v4` 里有顶层读取环境变量的写法），所以 profile 用动态 import。
- 配置较长的插件（LLM、ComfyUI 等）抽到 `shared/` 的函数里，`v4`、`v5` 引用同一份，避免复制。只抽两边都装的；只有 `v4` 用的留在 `v4.ts`。

## v5 首版内容

只装平台无关或已适配的部分；随适配进展增减。

**适配器**：只装 QQ 官方（`koishi-plugin-adapter-qq-crack`）。`v5` **不加载 OneBot 适配器**，也不含 villa 的前缀分支；其余适配器同样不装。

**装**
- 核心与通用：help、commands、switch、http、assets-s3、admin、bind、callme、echo、rate-limit、recall
- 业务：about、dice、hljs、markdown、ping、profile、queue、sticker、to-image、webshot、who-asked
- LLM（含 ComfyUI、Gelbooru）、GitHub
- 控制台：Console、Auth、Status、Logger、LlmDashboard、LlmAdmin
- 内部：HTMLService、FallbackHandler、SilentSwitch、MessagesLogger、PatchCallme、PiggybackService、DatabaseAdmin、Homo、Reboot、SensitiveFilter、Spawn

**不装（依赖 OneBot）**：repeater、sili-name、mute、QQNT 表情回应、MgpGroupUtils、MinecraftConnect、FixQQSendLinks、version、Debug、GuildRequestFirewall、ProcessErrorHandler、Autowithdraw
**不装（用了合并转发）**：caniuse、pixiv、mediawiki
**不装（待重新设计）**：verify-fandom-user
**暂不装（未决）**：Dialogue 问答库、Analytics、Dataview、Explorer、Insight、Sandbox

## 验证

- `tsc` 的报错集合与改动前一致（已知的 `ctx.plugin(...)` 噪音不变）。
- 本地用 `v4` 启动，启动日志里的插件清单与改动前逐项一致。
- 本地用 `v5` 启动：无 QQ 凭据时不装适配器但能正常启动；有凭据时连上官方网关。
- `SILI_PROFILE` 为未知值时报错并列出可选项。

## 文档

改完同步更新 `CLAUDE.md`：「加新功能 = 在 `src/index.ts` 里注册」改为说明 profile 与注册位置，并加上 `SILI_PROFILE` 的用法。
