# 模型侧命令帮助

## 目标

模型可以按用途找到深层 Koishi 指令，并直接从帮助构造 `execute_koishi_command` 的参数。

## 约定

- `execute_koishi_command` 的 `_find_command_` 是模型专用的只读伪命令。它接受一个关键词，在可见目录的所有层级按名字或描述做大小写无关的子串匹配，返回完整命令名和描述。精确命中也列出其他匹配项。搜索在工具内部完成，无需注册 Koishi 命令。
- `help` 无参时列顶层概览，传完整名字时查看详情。系统提示词保留顶层概览，并指向 `_find_command_` 和 `help`。
- 选项显示实际的 JSON `options` 键、类型和描述。Koishi 自动注入的隐藏帮助选项由工具自身的 `help` 入口替代。
- 描述、用法、选项和本地化示例采用 Koishi 的空串回退。示例优先取 `.example()` 注册的列表，缺省时取本地化 `commands.<name>.examples`，与原生命令帮助的优先级一致。

## 验收

- `_find_command_` 搜索 `mute` 或 `禁言` 都能返回 `channel.mute.all` 与 `channel.mute.member`。用 `help` 加完整名字打开详情。
- 搜索 `channel.mute` 时同时列出它及匹配的子命令。
- 详情直接显示 `duration` 等 JSON 键，省略缺失翻译对应的用法或描述，展示命令注册的用法和示例。
