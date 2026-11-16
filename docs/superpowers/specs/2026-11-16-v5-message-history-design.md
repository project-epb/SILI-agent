# v5 统一消息记录

v5 的已服务频道统一写入 `channel_message`。记录收发方向、正文、发送者、时间、引用 ID 和去重后的 `mentions: string[]`。按 `platform + selfId + channelId + messageId` 去重。入站消息在进入命令前保存，出站消息在适配器确认发送后保存。收发各写一条控制台日志，媒体内联数据只显示长度。官方 QQ 继续沿用群激活和私聊放行规则；迁移用 OneBot 不进入消息记录。v4 继续使用原来的日志和历史查询。

保留 30 天。启动时幂等导入保留期内的 `qqbot_message`，保留原表。不回填文件日志或 OneBot 历史。

查询范围由当前会话的 `platform + selfId + channelId` 决定。历史按时间及消息 ID 排序，支持在指定消息处向前翻页。`who-asked` 查最近一天内 `mentions` 包含当前用户的最新一条入站消息。LLM 的 `read_channel_history` 一次最多读 30 条，可以从被引用的消息继续查阅。仅查询 bot 实际收到或发出的消息。
