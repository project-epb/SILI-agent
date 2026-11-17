# `plugins/llm/` — Claude 编辑须知

进入这个目录工作前，先翻一眼 `README.md` —— 那里有完整的子模块清单 + 一次 chat 的端到端流程图。本文件是 README 之外、改代码时**容易踩坑**的事。

## 协议层中央目录：`utils/protocol.ts`

所有送给 agent 的 XML 标签（`<turn_context>` / `<user_message>` / `<interrupt_notice>` / `<system_compact>`）+ 所有 agent 输出的 marker（`[koishi:silent]` / `[koishi:msg_break]` / `[koishi:interrupted]` / `[koishi:img]`）都在这里集中。**别硬编码字符串**，从 `PROTOCOL_TAGS` / `PROTOCOL_MARKERS` 引。

dropset `PROTOCOL_ONLY_ELEMENT_TYPES` 保留了 legacy 字符串（如 `'chat_info'`、`'system:compact'`），因为老 history row 还含有这些 tag，agent 可能模仿输出 —— 改名时记得加 legacy 项，不要清掉。

## 数据库 schema 陷阱

**`openai_chat` 的排序键是 `(turn_number, intra_turn_seq)`，不是 `time`。**

- `turn_number` 由 `services/turn-allocator.ts` 单调分配，每次 chat invocation 占一个
- `intra_turn_seq`：user = 0 永远是 turn 头，后续 assistant / tool 行 ++seq
- `time` 是 wall-clock，会因打断 / 工具异步 / 并发写入产生不单调，**不要拿来做 history reconstruction 排序**

新增 history 相关查询时务必带 `sort: { turn_number: 'desc', intra_turn_seq: 'desc', id: 'desc' }`。

**`openai_chat.content`（role=user 行）存的是包装后的完整 envelope**，不是裸 prompt —— 含 `<turn_context>` JSON + `<user_message>` 块。这样下一轮 history 复用时与上一轮真正发给 provider 的字节一致，prefix cache 才能命中。改 envelope 结构 = 直接影响所有老 row 的 cache 友好度。

**`openai_session.prev_session_id`** 非空 = 该 session 由 SummaryCompactor 从前一个 conversation 摘要派生，可顺链回溯历史。`llm.compact` 命令手动触发；自动触发阈值 `summarizeAfterUserTurns`（默认 50 条 user 消息）。

## System prompt 的派生 + 缓存

`services/system-prompt.ts` 是按 `(basePrompt, catalog, extensions)` 进程内 memoize 的 —— 跨用户、跨 session 共享同一字符串，最大化 provider prompt cache 命中率。

- 改了 prompt 文件 / 字段 / 词条都会让缓存失效一次 → 下次 chat 会有一次"冷启动"高 miss，之后回到常规命中率
- 第三方插件可以监听 `llm/build-system-prompt` 事件往 `SystemPromptRegistry` 加段，但**贡献必须 deterministic** —— 列表里包含每次都变的值（时间戳 / 随机数）会让 cache 永远 miss

## Agent loop / 工具入口

- `agent-loop.tsx`：核心多轮迭代，handles abort / tool dispatch / 流式 chunk 累积 / 入库时机决策。改这里前请通读，逻辑密度高。
- `tools/` 下每个文件是一个 LLM tool；新增 tool 需在 `index.tsx` 里 `this.tools.register(...)` 注册（可带 conditional，如只在某 provider 配置存在时启用）。
- `tools/execute-koishi-command.ts` 走了一个 hack：劫持工具内部 `session.send` 让命令插件的"直接发图"也能被 agent 接收 —— 改这里小心，影响所有第三方插件命令的工具化输出。

## Provider 适配

`providers/openai.ts` 兼容 OpenAI / DeepSeek / OpenRouter / Qwen 等所有走 OpenAI 协议的后端。`providers/anthropic.ts` 单独。usage 统一映射成 `{promptTokens, completionTokens, totalTokens, cachedTokens, reasoningTokens}`，**Anthropic 的 `input_tokens` 不含 cache_read/cache_creation**，已在 anthropic.ts 内 sum 起来还原成总量（避免命中率算成 >100%）。

`mergeUsage`（agent-loop.tsx 内）的 `addUndef` helper 区分"没报告"（undefined）vs"报告 0"，不要简单 `?? 0` 替换 —— 会丢失"模型支不支持某统计"的信号。

## 长期记忆子系统

三份记录，都按 (platform, 主人 id) key：
- **私密记录** `services/memory.ts`（`openai_user_memory`）：只在私聊读写，上限 `memoryByteLimit`（默认 3000 byte）。`memory-fork-scheduler` 在用户消息累计到 `memoryUpdateInterval` 后触发后台 fork 整理它；fork 失败有 `memoryForkMaxRetries` 容错。
- **共享记录** `services/shared-memory.ts`（`openai_user_shared_memory`，主人是 uid）：所有群可见，上限 `sharedMemoryByteLimit`，只由 AI 主动写入。
- **群记忆**（同一个 `MemoryRecordStore`，`openai_group_memory`，主人是 channelId）：只在本群读写，上限 `groupMemoryByteLimit`，只由 AI 主动写入。

`read_user_memory` / `save_user_memory(tier, content)`：个人记录的主人永远是触发这一轮的人，群记忆的主人是当前群（`LLMPlugin.memoryOwners`）。私密记录只在私聊（`session.isDirect`）、群记忆只在群里；这一轮带了别人的消息（steer / backlog）时拒绝写个人记录。读写结果用 `<user_memory owner uid tier>` 标明归属。

`services/memory-snapshot.ts` 的 `buildMemorySnapshot()` 把 `LLMPlugin.memorySources()` 给的记录渲染成 `<long_term_memory>` 块（`snapshotTiers`：私聊带私密 + 共享，群共享会话只带群记忆）—— 在两处被调用：
1. 新 conversation 第一条 user 消息（fresh / reset / idle-rotated）：让模型一开始就有记忆 in-context
2. SummaryCompactor 的 summary user 消息：让压缩后的新 session 也带记忆

这两处不要重复注入。判别逻辑：`histories.length === 0` 时 chat.tsx 自己加；compaction 路径由 compactor 自己加。

## 测试

`__tests__/` 与被测代码同目录。运行：

```bash
npx vitest run src/plugins/llm/__tests__              # 全部
npx vitest run src/plugins/llm/__tests__/<file>.test.ts  # 单个
```

provider 层（openai.ts / anthropic.ts）目前**无单测** —— stream / abort 行为难 mock，集成测试靠真跑。改 provider 改完务必本地起一轮真聊天验证（参考根目录 `CLAUDE.local.md` 的 restart 流程）。
