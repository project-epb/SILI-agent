# LLM command catalog：agent / 人类双视图分离

## 背景与动机

SILI 的 agent 不直接拥有「函数式 tools」去调用大多数业务功能，而是通过 **command catalog** 感知所有 koishi 命令，再用内建工具 `execute_koishi_command` 间接调用（mediawiki / pixiv / dice 等都走这条路）。catalog 由 `src/plugins/llm/utils/command-catalog.ts` 的 `buildCommandCatalog(ctx)` 扫描 `ctx.$commander` 构建。

这套机制有两个让「用 koishi 命令承载纯 agent 工具」很别扭的短板：

1. **catalog 的 description 与人类 `help` 同源**，没有「只给 agent 看」的渠道。想把命令描述写成 skill/trigger 风格（「当需要……时调用」）就会同时出现在人类 help 里；反之想给人类写功能说明，agent 概览又拿不到触发线索。
2. **`hidden` 对 agent 和人类一刀切**。`buildCommandCatalog` 第 197 行 `if (cmd.config?.hidden) return null` 让 hidden 命令对 agent 也消失，无法表达「人类 help 里藏起来、但 agent 能看见并调用」——而这正是「用 koishi 原生方式注册一个纯 agent 工具」所需要的视图。

第一个直接受益者是即将开发的 ComfyUI 插件（见 `2026-06-23-comfyui-plugin-design.md`）：它的 `comfyui.*` 命令本质是 agent 工具，人类 `help` 里不需要看到，description 也应是 skill 风格。本 spec 解决的是通用基础设施，独立于 ComfyUI，单独实现 + 测试 + 回归。

## 现状约束（实现依据）

来自当前代码与依赖版本（koishi `^4.18.9`、官方 `@koishijs/plugin-help`）：

- **description 取值链**（`buildCommandCatalog`，约 207–211 行）：
  ```ts
  const description =
    i18n(`commands.${cmd.name}.description`) ||
    cmd._description ||
    cmd.config?.description || ''
  ```
  与人类 help 同源。注意 `description` 是 `ctx.command('name', '<desc>')` 的第二参数（落到 `cmd._description` / i18n），**不是** `config` 字段。
- **system prompt 概览只渲染 description 一行**：`renderCompactCatalog` 每条命令仅输出 `` `name` — description ``，不含 args / options / usage。agent「闲聊状态要不要调某命令」的判断**完全依赖这一行**；只有它决定深入、调 `help <cmd>` 时，`renderCatalogEntryDetail` 才展开 usage / args / options。→ 触发线索必须落在 description。
- **hidden 一刀切**：`buildCommandCatalog` 第 197 行对 `cmd.config?.hidden` 直接 `return null`。
- **官方 `hidden` 的真实作用域只是人类 help**：`@koishijs/plugin-help` 第 65 行用 `Schema.computed(Schema.boolean())` 给 `Command.Config` 加 `hidden`，第 150 行 `if (!showHidden && session.resolve(command.config.hidden)) continue` 跳过。**plugin-help 不感知 agent**；agent 是否隐藏完全由我们的 `buildCommandCatalog` 决定。plugin-help **只读 `config.hidden`**，无人类专属 hook。
- **Command.Config 可扩展**：koishi 4.18 `export namespace Command { interface Config extends ... }`。标准模块增强 `declare module 'koishi' { namespace Command { interface Config {...} } }` 即可 merge（`hidden` 本身就是 plugin-help 这样加进去的）。

## 设计

### 字段（复用官方 `hidden`，新增四个）

| 字段 | 类型 | 语义 |
|---|---|---|
| `hidden` | `Computed<boolean>` | **官方字段，语义不变**：对所有情况隐藏（人类 help + agent catalog）。 |
| `hideForHuman` | `boolean?` | 仅对人类 `help` 隐藏，agent catalog 仍可见。让命令以「纯 agent 工具」形式存在。 |
| `hideForAgents` | `boolean?` | 仅对 agent catalog 隐藏，人类 `help` 正常可见。 |
| `descriptionForAgents` | `string?` | 存在则 catalog（含 system prompt 概览 + 详情）的描述用它，**忽略**原 `description`；缺省回落原取值链。用于写 skill/trigger 风格描述而不污染人类 help。 |
| `helpForAgents` | `string?` | agent 调 `help <cmd>` 详情里的描述段优先用它（更技术性、面向 agent 的用法说明）；缺省回落 description / usage。 |

新增四字段全可选；都不设 = 现状行为完全不变。`hidden` / `hideForHuman` / `hideForAgents` 表达三种不同隐藏意图，不应在同一命令上叠加（`hidden` 已含全隐藏）。

### 视图矩阵

| 命令配置 | 人类 `help` | agent catalog（概览/可调用） |
|---|---|---|
| 默认 | 可见 | 可见 |
| `hidden` 真 | 隐藏 | 隐藏 |
| `hideForHuman: true` | 隐藏 | 可见 |
| `hideForAgents: true` | 可见 | 隐藏 |
| `descriptionForAgents` / `helpForAgents` | 不受影响（用原 description/usage） | 描述 / help 用 agent 专用版 |

## 实现落点

### 1. 类型扩展

一处 `declare module 'koishi'`（放在 llm 插件下，例如 `utils/command-catalog.ts` 顶部或独立 `command-config.d.ts`），扩展 `Command.Config` 四个新字段。

### 2. agent 侧过滤与取描述（`buildCommandCatalog`）

- **过滤逻辑改写**（替换现第 197 行的 `if (cmd.config?.hidden) return null`）：
  ```ts
  if (cmd.config?.hideForAgents) return null
  if (cmd.config?.hidden && !cmd.config?.hideForHuman) return null
  ```
  - 纯 `hidden`：`hidden && !hideForHuman` 为真 → 跳过（agent 隐藏）。
  - `hideForHuman`（投影后 `config.hidden` 也为真，见落点 3）：`hidden && !hideForHuman` 为假，`hideForAgents` 为假 → 保留（agent 可见）。
  - `hideForAgents`：直接跳过。
- **description 取值链头部插入 `descriptionForAgents`**：
  ```ts
  const description =
    cmd.config?.descriptionForAgents ||
    i18n(`commands.${cmd.name}.description`) ||
    cmd._description || cmd.config?.description || ''
  ```
- **`helpForAgents` 进 entry**：`CommandCatalogEntry` 增一个可选字段（如 `agentHelp?: string`），`renderCatalogEntryDetail` 的描述段优先用它（缺省回落 `entry.description` + `entry.usage`）。

### 3. 人类侧：`hideForHuman` 投影到官方 `hidden`

plugin-help 只读 `config.hidden`，所以让 `hideForHuman` 对人类 help 生效的唯一途径是把它投影进 `config.hidden`：

- 监听 `command-added`（plugin-help 自己第 74 行也是这么挂 `enableHelp` 的），对 `cmd.config.hideForHuman === true && !cmd.config.hidden` 的命令设 `cmd.config.hidden = true`。
- 仅在「未显式设 hidden」时投影，避免覆盖使用方意图；投影只写布尔 `true`。
- 投影后 agent 侧靠落点 2 的 `!hideForHuman` 豁免，仍可见——`hideForHuman` 字段本身是豁免依据，故不丢信息。
- plan 阶段验证 hook 时序：本插件的投影 hook 与 plugin-help 的 `enableHelp` 都监听 `command-added`，需确认两者对同一命令的处理互不破坏（plugin-help 给命令挂 `.help` 选项，与 `config.hidden` 取值无关，预期无冲突）。

### 4. `descriptionForAgents` 与 prompt cache 的约束

`renderCompactCatalog` 输出进 system prompt，而 system prompt 按 `(basePrompt, catalog, extensions)` 进程内 memoize（`services/system-prompt.ts`）。因此 `descriptionForAgents` **必须是 deterministic 静态串**——不得含时间戳 / 随机数 / 每次变化的值，否则 catalog 字符串每次不同，prompt cache 永久 miss。与现有 description 约束一致，文档记录在案。

## 向后兼容

- 新增四字段全可选，缺省时取值链与过滤逻辑等价于现状（`hidden && !hideForHuman` 在 `hideForHuman` 缺省时退化为 `hidden`，与旧 `if (hidden)` 完全等价）。
- 回归保证：**现有所有命令的 catalog 输出（概览 + 详情）逐字节不变**。验收硬条件。

## 测试

`src/plugins/llm/__tests__/command-catalog.test.ts`（已存在，纯函数易测）扩展用例，针对 `buildCommandCatalog` + 渲染函数（用现有 stub 方式构造带 `config` 的假命令，无需真起 koishi）：

1. `descriptionForAgents` 设置时，概览与详情用它；不影响 mock 的人类 description。
2. `descriptionForAgents` 缺省 → 回落原取值链（回归）。
3. `hideForHuman: true` → 出现在 catalog（agent 可见）。
4. `hideForAgents: true` → 不出现在 catalog。
5. 纯 `hidden: true`（无 hideForHuman）→ 不出现在 catalog（回归）。
6. `helpForAgents` → `renderCatalogEntryDetail` 描述段用它；缺省回落 description/usage。
7. 综合回归：一组无新字段的命令，catalog 输出与改动前快照一致。

投影 hook（落点 3）依赖 koishi 事件与 config 写入，纯函数测不到，靠一次真实启动验证：注册一个 `hideForHuman` 命令，人类 `help` 不列、agent catalog 含它。

## 边界与风险

- **隐藏字段叠加**：`hidden` / `hideForHuman` / `hideForAgents` 语义互斥，文档约定不在同一命令并用；投影 hook 跳过已显式设 hidden 的命令避免覆盖。
- **`descriptionForAgents` 的 cache 约束**：见落点 4，靠文档 + code review 把关。
- **投影 hook 时序**：见落点 3，plan 验证与 plugin-help 的 `command-added` 监听共存无碍。
- **`Computed<boolean>` 形式的 hidden**：若某命令 `hidden` 是函数而非布尔，落点 2 在构建期（无 session）对函数值 truthy → 当作 hidden 处理。现状第 197 行同样如此，行为不回归；精细化是后续话题，本 spec 不处理。
