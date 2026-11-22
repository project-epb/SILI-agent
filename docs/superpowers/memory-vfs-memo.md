# 备忘：记忆系统迁移为 VFS 文件

方向：参照 only-chat 的记忆插件（`only-chat/docs/superpowers/specs/2026-10-03-memory-plugin-design.md`），把 SILI 的长期记忆从 `read_user_memory` / `save_user_memory` 两个专用工具，改为一批记忆文件 + 系统提示词里的目录（catalog）。正文用通用的 `read_file` / `write_file` / `edit_file` 读写。

前提已具备：linux-agent 提供了完整的文件编辑工具。

约束：

- 记忆文件不放进 Linux VM。VM 里所有会话共用 `user`、目录之间没有权限隔离，私密记录会被别的会话读到。记忆是宿主一侧的虚拟路径（如 `/memory/private/`、`/memory/shared/`、`/memory/group/`），文件工具按路径前缀路由到宿主，由宿主按会话鉴权；其余路径才进 VM。
- 现有三层的读写规则照搬：私密记录只在本人私聊可读写；共享记录本人可写、各群可读；群记忆只在本群。`othersSpoke` 之后拒绝写私密记录的规则保留。
- catalog 进系统提示词会随会话变化，破坏共享前缀缓存；only-chat 的做法是把它放进用户消息或首轮注入，不进系统提示词。
- 后台记忆整理（memory fork）改为对同一批文件做编辑。
