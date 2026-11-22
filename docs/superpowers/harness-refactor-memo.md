# 备忘：LLM harness 重构方向

参照 only-chat 的 harness 设计收拢，按块进行，不重写。

- **能力即子插件**：memory、web-search、channel-history、execute-koishi-command 各自作为 llm 的子插件加载，在自己的生命周期里注册工具和 `<plugin id>` 系统提示词段，随插件卸载一起释放。现在它们的工具和段落都在 `llm/index.tsx` 里集中注册。
- **拆 `chat.tsx`**：流式输出、插话与停止、持久化、信封拼装都挤在一个 action 里；先把插话/停止的状态机抽出来。
- **协议文字与 Koishi 分开**：`koishi_system` 里的「消息协议」「输出格式」「输出节奏」是 IM 协议而不是 Koishi 本身的规则，宜成为独立段落。
- **指令目录在 `ready` 之后才长全**：有插件在 `ready` 后加载，重启后头一分钟的对话看到不完整的目录，每次重启多失效一次前缀缓存。
- **前缀稳定的约定**：系统提示词段按 id 排序、工具按名字排序、指令目录按名字排序；进程启动一分钟后日志打印系统提示词与工具列表的 sha256，跨重启对比即可确认缓存前缀未变。
- **skills**：VM 里放一个 skills 目录，每个 skill 一个文件夹（`SKILL.md` + frontmatter 描述）。宿主读出名字和描述，作为 `<plugin id="skills">` 段的目录进系统提示词，正文由她用 `read_file` 按需读。目录只在增删 skill 时变，不常打破前缀缓存。
- **MCP**：不在 harness 里接 MCP 协议；在 VM 里装把 MCP 服务包装成命令行的客户端，经 `exec` 调用，用法写进对应 skill。
