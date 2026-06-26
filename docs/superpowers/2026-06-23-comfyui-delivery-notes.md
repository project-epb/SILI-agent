# ComfyUI 插件 + catalog 双视图 — 交付总结

> 本次任务的实施纪要与待对齐事项。SDD 全流程（brainstorm → spec → plan → sub-agent 实施 → review → docker 验证）已完成。

## 做了什么

两块改动，分两个 spec/plan：

1. **LLM catalog agent/人类双视图分离**（前置基础设施）
   - 给 koishi `Command.Config` 加四字段：`descriptionForAgents`、`helpForAgents`、`hideForHuman`、`hideForAgents`。
   - `buildCommandCatalog` 据此决定 agent 侧描述与可见性；人类侧靠把 `hideForHuman` 投影到官方 `config.hidden`（plugin-help 只认它）。
   - 缺省时逐字节回归现状。spec/plan：`specs/2026-06-23-llm-catalog-agent-views-design.md`、`plans/2026-06-23-llm-catalog-agent-views.md`。

2. **ComfyUI 图像生成插件** `src/plugins/comfy-ui/`（移植自 Hermes Python 版）
   - 三命令 `comfyui.templates` / `comfyui.guide` / `comfyui.generate`，注册为纯 agent 工具（`hideForHuman` + skill 风格 `descriptionForAgents`）。
   - 配置注入式 + 导出 `scanWorkflowTemplates` / `scanGuides` 静态方法；认证统一进 `http: HTTP.Config`（`ctx.http.extend`）；出图走 `h.image(dataUri)`，ref 化由 llm 侧自动兜底，**不 inject llm**。
   - 全套功能：aspect_ratio 预设、LoRA 池叠加、model guide。
   - 详见 `src/plugins/comfy-ui/README.md`。

## 关键技术决策（与初始设想的偏离，均经你确认）

- **命令而非 LLM 工具**：放弃 Hermes 的「注册 LLM 工具」范式，改用 koishi 命令 + catalog，故 ComfyUI 不依赖 llm 内部 API。
- **认证收敛进 `HTTP.Config`**：放弃 `auth:{type}` 判别联合，三种鉴权本质都是 HTTP 头，统一用 `http.headers` + 导出 `basicAuth` helper。
- **catalog 双视图作为独立前置**：而非在 ComfyUI 里硬塞，做成通用基础设施。

## 测试与验证状态

- 单测：comfy-ui 86 + command-catalog（plan A）；全 llm 套件 375 全绿；`tsc` 无 comfy-ui/command-catalog 错误。
- docker 集成（重启本地 dev core，feat/comfyui 代码）：插件加载 + 惰性无害 + 三命令注册成功 + catalog rebuilt，无运行期错误。
- **docker 暴露并修复了一个 vitest 覆盖不到的 bug**：`comfyui.generate` 的 `height` option 短旗标 `-h` 与 koishi 内置 `-h/--help` 冲突 → 改为仅长名 `--height`。`index.tsx` 命令注册因 koishi 在 vitest 下不可 import 而无单测，只有真实 runtime 能暴露。

## 需要你关注 / 决策的事项

1. **未 push**：`master` 有 2 个 commit（解除 `docs/superpowers` gitignore + 归档历史文档），`feat/comfyui` 有本次全部 commit。都在本地，等你指令再 push。
2. **真实出图链路未端到端验证**：需要配置真实 ComfyUI 后端（`http.baseURL` + 认证头）+ 放至少一个 API-format workflow JSON，且在群里触发，我无法独立完成。当前默认 `ctx.plugin(PluginComfyUI, {})` 是惰性无害态。部署方法见 README。
3. **catalog 双视图影响所有命令**：是对 llm 插件核心的改动（向后兼容，缺省回归），不止 ComfyUI 受益——任何命令现在都能用 `hideForHuman` 等四字段。
4. **本地 dev core 已重启**到 feat/comfyui 代码（含未合并改动）。如需回到 master 状态，切回 master 重启 core 即可。

## 已知 Minor（review 判定均「可留」，未阻塞）

- planA：`descriptionForAgents` 空串 fall-through（plan-mandated）；测试 fake ctx 用 `any`。
- planB：`scanWorkflowTemplates`/`scanGuides` 重名/坏文件「跳过+warn」；纯函数用 `console.warn`；client `e.code` 无注释；network 错误分支无单测；generate timeout 用可配置项（spec 有意扩展）；seed 随机上界 2^53（Python 2^63，无害）。

完整逐 task 进度见 `.superpowers/sdd/progress.md`（ledger，gitignore，不入库）。

---

## 追加：部署接入 + 访问控制（交付后）

### 数据 + 后端接入
- ComfyUI 的 workflow/guide 数据放 **`.volumns/core/comfyui/{workflows,guides}/`**（复用现有 `./.volumns/core:/app/data` 挂载，容器内 `/app/data/comfyui`；在 gitignore 的 `.volumns/` 下，不入库）。已从 Hermes 复制 7 个 workflow + 3 个 guide。
- `src/index.ts` 从 `data/comfyui` 扫描，后端走 `.env`：`COMFYUI_BASE_URL` / `CF_SERVICE_TOKEN_ID` / `CF_SERVICE_TOKEN_SECRET`（沿用 Hermes 变量名；当前 CF Zero Trust 单后端）。未配 `COMFYUI_BASE_URL` 时惰性无害。
- 验证：重启 core 日志 `comfyui: 7 templates, 3 guides`——**7 个真实 workflow（含带冒号 node id 的 subgraph 格式）全部成功解析**。

### 访问控制（防群友刷爆显卡）
- `comfyui.generate` 加 `authority` + `minInterval`（冷却）+ `maxUsage`（每日上限），施加在 koishi 命令层；agent 经 `execute_koishi_command` 调用按**调用者身份**检查（已实测 agent 沿用用户权限等级；rate-limit hook 在 `command/execute`，同路径生效）。
- 经 `.env` 可调：`COMFYUI_GENERATE_AUTHORITY` / `COMFYUI_GENERATE_MIN_INTERVAL_S`（秒）/ `COMFYUI_GENERATE_MAX_USAGE`。SILI 默认 authority=1 / minInterval=30s / maxUsage=0（不限）。
- 注册了 `comfyui` 根命令（带 `descriptionForAgents`）：catalog 概览只渲染 top-level，根命令描述是 agent 概览阶段感知「能画图」的唯一线索。

### rate-limit 类型误报根因（顺带修复）
- 全项目 `minInterval does not exist in Config` 误报的根因：① `app-env.d.ts` 原 import 的是 `@koishijs/plugin-rate-limit`（未安装），实际用的是社区包 `koishi-plugin-rate-limit`；② 即便包名对，pnpm 把其 peer `koishi` 钉在 `4.18.0`，包内 `declare module 'koishi'` 增强打在该实例，与 src 用的顶层 `koishi@4.18.9` 不互通。
- 修法：在 `src/plugins/comfy-ui/index.tsx` 内**直接** `declare module 'koishi'` 补 `maxUsage`/`minInterval`（`Computed<number>`）——src 内文件 augment 的就是顶层 koishi，可靠生效，顺带消除 chat/mediawiki/sticker 的同类误报。

### docker 集成发现并修复的 bug
- `comfyui.generate` 的 `height` option 短旗标 `-h` 与 koishi 内置 `-h/--help` 冲突（`duplicate option name "h"`）→ 改 `--height`。仅真实 koishi runtime 能暴露（index.tsx 命令注册无单测）。

## 追加：提示词过滤 / 扩展点（2026-06-25）

设计见 `specs/2026-06-25-comfyui-filter-hooks-design.md`。两层机制，限制/改写 `comfyui.generate` 入参：

- **event `comfyui/before-generate`**（`ctx.serial`，async）：参数校验后、`applyOverrides` 前 emit；监听器可就地改 `args`，或返回非空字符串 / 抛错 = 拒绝（原因回 agent）。复杂审核（正则、外部 API、按群查 DB）挂这里。
- **内置 filter 配置**（声明式便利层）：`filter.{blacklist,forcePositive,forceNegative}`，`Computed<T>` 按群/按人。blacklist 命中即拒绝；force* 追加强制词（forceNegative 保留模板 seed_negative）。底层是插件自注册的一个 `comfyui/before-generate` 监听器。
- 纯函数 `filter.ts`（`applyBuiltinFilter`）+ 7 个单测；命令层 emit/拒绝靠 docker 集成验证（启动 + event 注册无错误）。
- 频道白名单同期改用 `channelId`（群=群号，私聊=`private:<QQ号>`），默认放行沙盒群/NGNL 群/站长私聊。
