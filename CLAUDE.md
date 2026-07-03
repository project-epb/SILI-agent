# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

SILI 是基于 [Koishi](https://koishi.chat/) 的群聊机器人，主要部署在 QQ（NapCat OneBot 适配器），也支持 Discord / KOOK / DingTalk / 卫星等。

Runtime: **bun**（dev 与生产统一）。bun 同时是包管理器和运行时——`bun ./src/index.ts` 直接跑 TS/JSX，取代了过去的 tsx。Node >= 24.11（部分原生 API 依赖；bun 自带 CJS 兼容运行时，koishi 的 CJS loader 才跑得起来）。JSX 经 `src/satori-jsx/` 的 shim 暴露具名导出（satori 是 default-only ESM，严格 loader 直接 import 具名会失败）。

**SILI 命令前缀按部署不同**：生产环境是 `!`、测试 / 本地 dev 是 `;`。本文档示例命令一律不带前缀（写 `chat` / `debug.history` / `llm.compact`），按你所在环境补上即可。

## Scripts

| | |
|---|---|
| `bun start` | 生产启动 |
| `bun dev` | 本地开发（`bun --watch ./src/index.ts`） |
| `bun test` / `npx vitest run` | 跑全量测试一次 |
| `bun test:watch` / `npx vitest` | watch 模式 |
| `npx vitest run <path>` | 跑单个文件 / 目录 |
| `npx tsc --noEmit -p .` | 类型检查（见下方「已知 tsc 噪音」） |
| `bun run format` | prettier 格式化 `src`（脚本已限定到 `src`，不碰根目录 docs/config）；`bun run format:check` 只校验不改 |

测试在 `__tests__/` 子目录里，与被测代码同级 —— 大部分目录都自带一个（`src/plugins/llm/__tests__/`、`src/utils/__tests__/` 等）。

## 代码风格 & 已知 tsc 噪音

**格式化**：`.prettierrc.cjs` 配了 `@trivago/prettier-plugin-sort-imports`，import 有分组顺序（`dotenv → koishi → node: → @/ → ~/ → $utils/ → @koishijs/ → koishi- → 第三方 → 相对`，组间空行）。format 脚本只跑 `src`（根目录 docs/config 不归 prettier 管）。注意 `src` 里仍有一批历史文件未格式化，所以 **别整体跑 `bun run format`（会 reformat 历史文件、污染 diff）——推送前只格式化本次改动过的文件**，单独作为最后一笔提交，别混进功能 diff。

**已知 tsc 噪音**：`npx tsc --noEmit` 会报若干 `ctx.plugin(...)` 的 `No overload matches this call`——koishi 4.9 前后一次较大的类型调整所致，命中的是几个停更的老第三方插件，**不影响实际运行**。别把它们当成自己改动引入的错误。

## 路径别名（tsconfig）

```
@/*       → src/*
~/*       → src/plugins/*
$utils/*  → src/utils/*
```

非标准的 alias 集合，平时 grep / import 时注意。

## JSX

JSX 不是 React。`tsconfig.json` 里 `"jsxImportSource": "@satorijs/element"` —— `.tsx` 文件里的 JSX 编译成 satori h-elements（`<image src=...>` / `<at id=...>` / `<random>...</random>`），是 koishi 发消息的原生表示。**不要当 React 用**（没有 useState / Fragment 语义不同 / 等等）。

## 顶层结构

```
src/
├── index.ts            App + 全部插件加载入口
├── adapters/           自研适配器（minecraft）
├── modules/            进程级辅助（logging / firewall / fallback handler …）
├── services/           对外注入式服务（html 渲染、QQ NT emoji reaction、piggyback…）
├── utils/              纯函数工具
└── plugins/            业务插件（一个文件 / 一个目录 = 一个 koishi plugin）
    ├── llm/            ← 自研 LLM agent 栈，整个项目最重的部分（独立 README）
    ├── debug/          调试命令（`debug.*`，authority 3+）
    ├── mediawiki/      MediaWiki 查询
    ├── pixiv.ts        Pixiv 图片
    ├── dice.ts         骰子
    └── ...             （每个文件就是一个 koishi 命令插件）
```

加新功能 = 在 `src/plugins/` 加文件（或目录） + 在 `src/index.ts` 里 `ctx.plugin(YourPlugin)` 注册。

## LLM 插件特别说明

`src/plugins/llm/` 是项目最重的子系统。改它之前必读两份文档：

- `src/plugins/llm/README.md` —— 子模块清单 + 一次 chat 的端到端流程图
- `src/plugins/llm/CLAUDE.md` —— Claude 编辑须知（DB schema 陷阱、协议中央目录、provider 适配差异等踩坑点）

Claude Code 进入该目录工作时会自动叠加加载那份 CLAUDE.md。

## 本地开发偏好

本机部署 + 容器操作 / 日志位置 / restart 流程等环境特定的事写在 `CLAUDE.local.md`（gitignore），由各部署环境各自维护。

@CLAUDE.local.md
