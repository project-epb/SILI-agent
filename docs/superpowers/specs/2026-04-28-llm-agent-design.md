# LLM Plugin: Agent 改造设计

## Goal

把 `src/plugins/llm` 从单轮聊天接口改造成真正的 agent：
- LLM 可以以用户身份调用 Koishi 指令（function calling / tool use）
- 每个用户拥有独立的 markdown 格式长期记忆，由 AI 周期性自主维护
- 改造保持现有用户触发方式（`llm/chat` 或问号结尾），仅在响应链路上增加 agent 循环

## Non-Goals

- 不引入自治 agent（机器人不主动发言、不主动监听全部消息）
- 不做指令白名单/黑名单（agent 拥有用户能调用的全部权限）
- 不引入向量检索、自动摘要等复杂记忆机制（参考 OpenClaw：单文件 + 容量上限 + AI 自主取舍）
- 不改变 prompt 模板的整体形态（仅注入命令目录和记忆占位）

## 整体架构

```
用户消息 (llm/chat)
    │
    ▼
加载用户记忆 ──→ 构建 system prompt ──→ LLM (with tools)
    │              │                          │
    │  命令目录    │                  ┌───────┴───────┐
    │  (静态，吃缓存)│                 │               │
    │              │              文本回复          tool_call
    │              │                  │               │
    │              │                  ▼               ▼
    │              │             流式输出给用户     execute_koishi_command
    │              │                                  │
    │              │                                  ▼
    │              │                             结果作为 tool 消息
    │              │                             回到 LLM (loop)
    │              ▼
    │         agent loop 结束
    │
    ▼
[异步] 每 10 条 user 消息触发一次 memory fork
    │
    ▼
另起一次 LLM 调用，原样传入对话历史 + 专用 system prompt
    │
    ▼
返回新记忆内容 或 魔法值 <<NO_UPDATE>>
    │
    ▼
落库到 openai_user_memory 表
```

## 改动文件清单

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `src/plugins/llm/providers/_base.ts` | 修改 | 扩展类型支持 tool calling |
| `src/plugins/llm/providers/openai.ts` | 修改 | 消息适配、tools 参数、流式聚合 |
| `src/plugins/llm/providers/anthropic.ts` | 修改 | content blocks 转换、tools 参数、流式聚合 |
| `src/plugins/llm/index.tsx` | 修改 | schema 扩展、agent loop、命令目录、history 改造 |
| `src/plugins/llm/tools.ts` | 新增 | 工具定义（`execute_koishi_command`）和执行器 |
| `src/plugins/llm/memory.ts` | 新增 | `MemoryStore` 类、memory fork 调度 |
| `src/plugins/llm/prompts/SILI-v5.prompt.md` | 修改 | 加入命令目录占位、记忆使用说明 |

---

## 1. Provider 层类型扩展（`_base.ts`）

```typescript
// 工具定义（注入到请求里）
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, any>  // JSON Schema
}

// 完整工具调用（聚合后整体 yield）
export interface ToolCall {
  id: string                         // tool_call_id
  name: string
  arguments: Record<string, any>     // 已 JSON.parse
}

// ChatMessage 改为联合类型
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string                // 可为空字符串（纯工具调用回合）
      tool_calls?: ToolCall[]
    }
  | {
      role: 'tool'
      tool_call_id: string
      tool_name: string              // 仅用于日志和数据库列
      content: string                // 工具执行返回的字符串
    }

export interface ChatCompletionOptions {
  model: string
  maxTokens?: number
  temperature?: number
  topP?: number
  tools?: ToolDefinition[]
  toolChoice?: 'auto' | 'none' | 'required'
}

export type StreamChatDelta =
  | { kind: 'reasoning_content'; content: string }
  | { kind: 'content'; content: string }
  | { kind: 'tool_call'; toolCall: ToolCall }
  | { kind: 'usage'; usage: ChatCompletionUsage }
  | { kind: 'error'; error: Error }
  | { kind: 'finish'; reason: 'stop' | 'tool_calls' | 'length' | 'other' }
```

**关键决策：tool_call 整体 yield，不做增量 delta**

- partial JSON 无法解析，agent 层也只在工具调用完成时才需执行
- provider 内部用状态机累积 JSON 片段
- 解析失败时 yield `error` 让 agent loop 把错误回喂 LLM 重试

---

## 2. OpenAI Provider 改动

### 消息格式适配

OpenAI SDK 原生支持 `role: 'tool'` 和 assistant 上的 `tool_calls`，只需做形状映射：

```typescript
function toOpenAIMessage(msg: ChatMessage): ChatCompletionMessageParam {
  switch (msg.role) {
    case 'tool':
      return { role: 'tool', tool_call_id: msg.tool_call_id, content: msg.content }
    case 'assistant':
      return {
        role: 'assistant',
        content: msg.content || null,
        ...(msg.tool_calls?.length && {
          tool_calls: msg.tool_calls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        }),
      }
    default:
      return { role: msg.role, content: msg.content }
  }
}
```

### tools 参数注入

```typescript
if (opts.tools?.length) {
  body.tools = opts.tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
  if (opts.toolChoice && opts.toolChoice !== 'auto') {
    body.tool_choice = opts.toolChoice
  }
}
```

### 流式聚合

OpenAI 的 tool_call delta 通过 `delta.tool_calls[].index` 区分多个并发调用：

```typescript
const toolCallBuffer = new Map<number, { id: string; name: string; argText: string }>()

for (const tc of delta.tool_calls ?? []) {
  const buf = toolCallBuffer.get(tc.index) ?? { id: '', name: '', argText: '' }
  if (tc.id) buf.id = tc.id
  if (tc.function?.name) buf.name = tc.function.name
  if (tc.function?.arguments) buf.argText += tc.function.arguments
  toolCallBuffer.set(tc.index, buf)
}

const finishReason = chunk.choices?.[0]?.finish_reason
if (finishReason) {
  for (const buf of toolCallBuffer.values()) {
    try {
      yield {
        kind: 'tool_call',
        toolCall: {
          id: buf.id,
          name: buf.name,
          arguments: JSON.parse(buf.argText || '{}'),
        },
      }
    } catch (e) {
      yield {
        kind: 'error',
        error: new Error(`Tool call JSON parse failed: ${buf.argText}`),
      }
    }
  }
  yield { kind: 'finish', reason: mapFinishReason(finishReason) }
}
```

---

## 3. Anthropic Provider 改动

### content blocks 转换（核心难点）

Anthropic 的工具调用走 `content blocks` 范式：
- 工具调用是 assistant 消息里的 `tool_use` block
- 工具结果是 **user 消息**里的 `tool_result` block（不是独立 role）
- 多个连续工具结果必须合并到同一个 user 消息

```typescript
function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = []
  let pendingToolResults: Anthropic.ToolResultBlockParam[] = []

  const flushToolResults = () => {
    if (pendingToolResults.length) {
      out.push({ role: 'user', content: pendingToolResults })
      pendingToolResults = []
    }
  }

  for (const m of messages) {
    if (m.role === 'system') continue  // 单独参数处理

    if (m.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: m.content,
      })
      continue
    }

    flushToolResults()

    if (m.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const tc of m.tool_calls ?? []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments })
      }
      out.push({ role: 'assistant', content: blocks })
    } else {
      out.push({ role: 'user', content: m.content })
    }
  }

  flushToolResults()
  return out
}
```

### tools 参数

```typescript
body.tools = opts.tools?.map(t => ({
  name: t.name,
  description: t.description,
  input_schema: t.parameters,
}))
```

### 流式聚合

Anthropic 的事件流是 `content_block_start` → `content_block_delta`*N → `content_block_stop`：

```typescript
const blockState = new Map<number, {
  type: 'text' | 'tool_use'
  id?: string
  name?: string
  argText: string
}>()

case 'content_block_start': {
  const block = event.content_block as any
  blockState.set(event.index, {
    type: block.type,
    id: block.id,
    name: block.name,
    argText: '',
  })
  break
}

case 'content_block_delta': {
  const state = blockState.get(event.index)!
  const delta = event.delta as any
  if (delta.type === 'text_delta') {
    yield { kind: 'content', content: delta.text }
  } else if (delta.type === 'thinking_delta') {
    yield { kind: 'reasoning_content', content: delta.thinking }
  } else if (delta.type === 'input_json_delta') {
    state.argText += delta.partial_json
  }
  break
}

case 'content_block_stop': {
  const state = blockState.get(event.index)
  if (state?.type === 'tool_use') {
    try {
      yield {
        kind: 'tool_call',
        toolCall: {
          id: state.id!,
          name: state.name!,
          arguments: JSON.parse(state.argText || '{}'),
        },
      }
    } catch (e) {
      yield { kind: 'error', error: new Error(`...`) }
    }
  }
  break
}

case 'message_delta': {
  const stopReason = (event as any).delta?.stop_reason
  if (stopReason) {
    yield { kind: 'finish', reason: mapAnthropicStopReason(stopReason) }
    // 'tool_use' -> 'tool_calls'
  }
  // usage 同现有逻辑
}
```

---

## 4. 工具定义和注册（`tools.ts` 新增）

主对话只暴露**一个**工具：`execute_koishi_command`。命令目录直接拼到 system prompt（吃缓存）。

```typescript
export const EXECUTE_KOISHI_COMMAND_TOOL: ToolDefinition = {
  name: 'execute_koishi_command',
  description:
    '以当前用户的身份执行一条 Koishi 指令并返回结果。指令清单和参数说明见 system prompt 中的「可用指令」章节。',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: "指令的完整路径名，如 'pixiv.illust' 或 'tools/homo'",
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: '位置参数列表，按指令定义的顺序传入',
      },
      options: {
        type: 'object',
        description: '选项 key-value，key 是选项名（不含 -- 前缀）',
        additionalProperties: true,
      },
    },
    required: ['name'],
  },
}
```

### 工具执行

```typescript
export async function executeKoishiCommand(
  session: Session,
  input: { name: string; args?: string[]; options?: Record<string, any> }
): Promise<string> {
  try {
    const result = await session.execute(
      {
        name: input.name,
        args: input.args || [],
        options: input.options || {},
      },
      true  // 第二个参数 true = 返回输出而不是 send
    )
    return typeof result === 'string' ? result : (result ?? '')
  } catch (e) {
    return `Error: ${e?.message || String(e)}`
  }
}
```

`session.execute(argv, true)` 的 `true` 参数让指令输出返回而不是直接发送，这样可以作为 tool message 喂回 LLM 而不在群里产生重复消息。

### 命令目录生成

启动时遍历 `ctx.$commander._commandList`，过滤 `hidden: true`，按以下结构提取：

| 字段 | 来源 |
|---|---|
| 指令名 | `command.displayName`（含完整路径） |
| 描述 | `ctx.i18n.get('commands.xxx.description')` |
| 参数 | `command._arguments` → name, type, required, description |
| 选项 | `command._options` → name, type, description |
| 子指令 | `command.children` 递归 |
| 用法 | `command._usage` |
| 别名 | `command._aliases` |

输出示例（注入到 system prompt）：

```
## 可用指令

help [command] — 显示帮助。无参列出所有指令，带参显示指令详情
pixiv.illust <id> — 获取 Pixiv 插画。参数: id(正整数, 插画 ID)
tools/homo <input> — 恶臭数字论证器。参数: input(任意文本)
sticker — 生成表情包。别名: 表情包
  sticker.状态码猫猫 <statusCode> — 生成 HTTP 状态码猫猫图
...
```

仅在启动时生成一次，所有请求完全一致，命中 prompt cache。

---

## 5. 记忆系统（`memory.ts` 新增）

### 数据库表

```typescript
declare module 'koishi' {
  interface Tables {
    openai_user_memory: OpenAIUserMemory
  }
}

interface OpenAIUserMemory {
  id: number
  platform: string
  user_id: string
  content: string
  byte_size: number
  last_updated_at: number
  last_check_at: number
  update_count: number
  message_count_at_update: number
}

ctx.model.extend('openai_user_memory', {
  id: 'unsigned',
  platform: 'string(64)',
  user_id: 'string(128)',
  content: 'text',
  byte_size: 'unsigned',
  last_updated_at: 'unsigned(20)',
  last_check_at: 'unsigned(20)',
  update_count: 'unsigned',
  message_count_at_update: 'unsigned',
}, {
  primary: 'id',
  autoInc: true,
  unique: [['platform', 'user_id']],
})
```

表名 `openai_user_memory` 与已有的 `openai_chat` 保持一致前缀（历史遗留）。

### MemoryStore API

```typescript
class MemoryStore {
  async get(platform: string, userId: string): Promise<string>
  async set(platform: string, userId: string, content: string): Promise<void>
  async getMeta(platform: string, userId: string): Promise<OpenAIUserMemory | null>
  async markChecked(platform: string, userId: string, currentMsgCount: number): Promise<void>
}
```

主对话用 `get` 拼到 system prompt；fork 任务用 `getMeta` 决定是否触发，用 `set` 或 `markChecked` 落库。

### Memory Fork 触发机制

每条 user 消息处理完后检查：

```typescript
const meta = await memory.getMeta(platform, userId)
const totalMessages = await countUserMessages(conversationId, platform, userId)
const since = totalMessages - (meta?.message_count_at_update || 0)

if (since >= 10 && !forkLocks.has(userKey)) {
  forkLocks.add(userKey)
  queueMicrotask(() =>
    runMemoryFork(platform, userId).finally(() => forkLocks.delete(userKey))
  )
}
```

锁粒度 per user (跨 conversation)，per-process 内存 Set。同用户多群同时聊天时避免并发写文件。重启后丢失没关系——下次累计到 10 时自然又会触发。

### Memory Fork 请求构造

替换主 system prompt，对话历史**原样保留**（含 tool 消息），最后追加触发指令：

```
[system]
你的任务：基于用户的对话记录，更新其个人记忆档案。

【当前记忆档案】
{memory 内容，为空时显示 "(空)"}

【输出规则】
1. 容量上限：{limit} 字节
2. 只保留对未来对话有价值的信息：
   - 用户画像（昵称、身份、长期偏好）
   - 重要事项（正在进行的事、未解决的话题）
   - 互动模式（用户的沟通习惯、雷区）
3. 不重要的细节让它自然遗忘——容量是硬约束，必须取舍
4. 如果对话相比当前记忆没有任何值得保留的新增信息，
   **只输出魔法值** <<NO_UPDATE>>，不要输出其他任何字符
5. 否则直接输出完整的新记忆内容（markdown 格式），
   不要包裹代码块、不要解释、不要前后缀

[原始对话历史，user/assistant/tool 全部保留]

[user]
请基于以上对话更新记忆档案。
```

### Fork 关键决策

| 问题 | 选择 | 理由 |
|---|---|---|
| 用什么模型 | 主 provider 同模型，可配置覆盖 (`memoryUpdateProvider`) | 灵活性，可选用更便宜的模型 |
| 是否 streaming | 否，整段拿 | 内部任务，无展示需求 |
| 是否带 tools | 否 | fork 任务不需要工具调用 |
| 失败处理 | 记日志，不重试 | 下个周期会再次触发 |
| 魔法值 | `<<NO_UPDATE>>` | 字符序列足够独特，LLM 误输出概率低 |
| 锁粒度 | per user (跨 conversation) | 避免并发写 |
| 输出超限 | 硬截断到 limit 字节并记 warning | 简单直接 |

### 记忆文件结构（由 AI 自行维护）

参考形态（不强制约束）：

```markdown
## 用户画像
- 昵称: xxx, 时区: Asia/Shanghai
- 喜欢猫，讨厌香菜
- 前端工程师，主要用 React

## 重要事项
- 2026-04-20: 下周五有面试，正在准备
- 上次问过 Python 装饰器，已解释清楚

## 偏好
- 回复风格: 简洁直接
- 代码语言: TypeScript
```

---

## 6. 数据库 schema 扩展（`openai_chat`）

```typescript
interface OpenAIConversationLog {
  id: number
  conversation_id: string
  conversation_owner: number
  role: 'system' | 'user' | 'assistant' | 'tool'  // 新增 tool
  content: string
  reasoning_content: string
  tool_calls?: string                                // 新增：JSON 序列化
  tool_call_id?: string                              // 新增：tool 角色用
  tool_name?: string                                 // 新增：tool 角色，便于排查
  usage?: ChatCompletionUsage
  model?: string
  time: number
}
```

`ctx.model.extend('openai_chat', ...)` 同步更新。Koishi 的 schema migration 会自动 ALTER TABLE 添加新列。

---

## 7. `getChatHistoriesById` 改造

`limit=10` 语义变更：从"10 条 user/assistant 消息（5 对）"改为"10 个 user→assistant 对话回合"，中间夹的 tool_call 和 tool 消息**不计数、不裁断**。

### 新算法

```
1. 查询阶段：按 time desc 拉取 N 条记录
   limit = expectedUserMessages * (1 + maxToolCallsPerTurn) + 余量
2. 分组阶段：从尾部往前扫，按 user 消息切片成"回合"
   每个回合 = 1 个 user + 后续若干 assistant/tool
3. 裁剪阶段：保留最后 N 个完整回合
4. 校验阶段：替换 isValidUserAssistantPairs 为 isValidConversationFlow
   合法序列：
   - user → assistant(text)
   - user → assistant(tool_calls) → tool* → assistant(text)
   不合法（丢弃）：
   - tool 开头的前缀（孤儿 tool 消息）
   - assistant(tool_calls) 后没对应 tool 响应（半截回合）
```

### 配置项

`historyMessageCount` 默认值 10 不变，含义从"消息条数 / 2"调整为"user 消息条数（回合数）"，对老用户透明。

---

## 8. Agent Loop 控制流（`index.tsx`）

```
chat action 入口
    │
    ▼
[准备阶段]
  - 加载用户记忆 → memory 文本
  - 拉取历史对话（含 tool 消息）→ messages[]
  - 构建 system prompt（命令目录 + 记忆 + 角色 prompt）
  - 准备 tools: [execute_koishi_command]
    │
    ▼
[Agent Loop, 最多 maxToolIterations 轮]
  ┌───────────────────────────────────────────────┐
  │ provider.streamChatCompletion(messages, tools)│
  │   ↓ 流式收集                                   │
  │   - text delta → 累积 currentText             │
  │   - tool_call → 累积 collectedToolCalls       │
  │   - finish → 记 finishReason                  │
  │                                               │
  │ 流结束分支:                                    │
  │   ├─ collectedToolCalls 为空                  │
  │   │   → 输出 currentText 给用户               │
  │   │   → 写 assistant 记录                     │
  │   │   → break                                 │
  │   │                                           │
  │   └─ 有 tool_calls                            │
  │       → 写 assistant(tool_calls) 记录         │
  │       → currentText 非空也输出给用户           │
  │       → 串行执行所有 tool_calls               │
  │       → 每个结果作为 tool 消息追加到           │
  │         messages 和数据库                     │
  │       → 进入下一轮                            │
  └───────────────────────────────────────────────┘
    │
    ▼
[终止条件]
  - assistant 输出无 tool_calls（正常结束）
  - 达到 maxToolIterations（强制最后一轮无 tools）
  - tool 执行抛致命错误（返回错误信息给用户）
```

### 关键决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 轮次上限 | 默认 5，可配置 | 防死循环；最后一轮把 tools 设为 undefined 或 toolChoice='none' 强制 LLM 总结 |
| 工具并发 | **串行** | session.execute 涉及 session 状态（如 sticker 的 send hook），并发可能互相干扰；串行也让用户能看到 SILI 一步步操作 |
| 用户可见性 | 配置项 `showToolCallNotice`，默认开 | 透明度，发送 `[SILI 正在执行: pixiv.illust 12345]` 类状态消息 |
| 流式输出 | 每轮 text delta 立即 stream | 用户能看到中间轮次的"让我先查一下..." |
| 工具失败 | 错误消息作为 tool message 回 LLM | 让 LLM 自主决定如何应对 |
| Provider 失败 | 抛到外层按现有逻辑处理 | 不变 |
| 工具不存在 | 同工具失败 | 不变 |

---

## 9. Prompt 模板更新

`SILI-v5.prompt.md` 加入两个占位段：

```markdown
{{...原有角色 prompt...}}

## 可用指令

{{COMMAND_DIRECTORY}}

调用方式：使用 `execute_koishi_command` 工具，传入 `name`、`args`、`options`。
**重要**：调用工具前先确认指令存在于上述清单中。

## 个人记忆

{{USER_MEMORY}}

以上是你对当前用户的长期记忆。在对话中可参考这些信息提供更贴合用户的回复。
记忆由系统周期性自动维护，你不需要在对话中主动更新。
```

`{{COMMAND_DIRECTORY}}` 在启动时静态生成，吃 prompt cache。
`{{USER_MEMORY}}` 每次请求时按用户加载，可能有缓存断裂。
两者顺序：命令目录在前（更稳定），记忆在后（用户级变化）。

---

## 配置项汇总

```typescript
interface Config {
  // ... 现有配置 ...

  // 新增
  enableAgent?: boolean              // 默认 true，可关闭回退到原行为
  maxToolIterations?: number         // 默认 5
  showToolCallNotice?: boolean       // 默认 true
  memoryByteLimit?: number           // 默认 8192 (8KB)
  memoryUpdateInterval?: number      // 默认 10 (条 user 消息)
  memoryUpdateProvider?: string      // 默认未设，复用主 provider
}
```

---

## 落地后的验证清单

- [ ] OpenAI provider 单工具调用单轮成功
- [ ] OpenAI provider 多工具并行调用单轮成功
- [ ] OpenAI provider 多轮工具调用串联成功
- [ ] Anthropic provider 同上三项
- [ ] 历史对话加载包含 tool 消息后不被错误丢弃
- [ ] 达到 maxToolIterations 时正常返回 LLM 总结
- [ ] 工具执行失败时错误消息正确回喂
- [ ] 命令目录静态注入，多次请求 prompt 完全一致
- [ ] 记忆 fork 在 10 条 user 消息后异步触发
- [ ] 同用户重叠请求不会并发触发 fork
- [ ] `<<NO_UPDATE>>` 魔法值识别正确，不会写入数据库
- [ ] 记忆超 8KB 时硬截断 + warning
- [ ] 进程重启后历史 message_count_at_update 仍可用，触发节奏不被打乱

## 不在本次范围内的后续工作

- 跨会话/跨平台记忆共享
- 工具调用的并发执行（如确认无 session 状态干扰可启用）
- 记忆文件的版本历史和回滚
- 多模态工具（图片/文件输出）
