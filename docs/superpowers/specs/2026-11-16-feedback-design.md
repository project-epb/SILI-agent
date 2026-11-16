# 用户反馈（仅 LLM 可提交）

## Goal

v5 上线后需要收集用户反馈。用户跟 SILI 聊天时提出的问题和建议，经 LLM 筛选润色后存档，维护者在 Koishi 控制台集中查看。

## Scope

- In：聊天 LLM 的「提交反馈」工具（用户要求时提交，或 LLM 主动静默提交）；`feedback` 表；控制台反馈页面。
- Out：用户可直接调用的指令；任何推送通知（QQ、飞书等）；回复反馈者。

## Decisions

1. **只有聊天 LLM 能提交，没有用户指令。** 工具名 `submit_feedback`，只注册给 LLM，不对应任何 Koishi 指令，`execute_koishi_command` 也调不到它。
   Why：维护者不想被 spam。用户得先说服 LLM 这是一条真反馈，LLM 本身就是第一道过滤。
   Rejected：`feedback <内容>` 指令——任何人都能直接刷。

2. **LLM 在调用时完成筛选和润色。** 工具参数：`title`（一句话标题）、`summary`（润色后的完整描述）、`category`（`bug` / `suggestion` / `other`）、`original`（用户原话，原样摘录）、`source`（见下条）。工具说明要求 LLM 只提交真实、具体、对维护者有用的反馈，刷屏、辱骂、无意义内容不提交。
   Why：聊天 LLM 已经有完整上下文，再单独调一次 LLM 筛选是重复劳动。
   Rejected：独立的 LLM 筛选调用，存下拒收记录——多一次调用和一套状态，换来的只是能看到被拒的垃圾。

3. **两种来源。** `requested`：用户明确要求反馈，提交后 LLM 告诉用户已转达。`observed`：LLM 在聊天中自己发现的问题（用户抱怨功能异常、SILI 自身出错、反复出现的困惑等），静默提交，不向用户提及。
   Why：大部分问题用户不会主动去「反馈」，聊天里顺口的抱怨同样有价值；静默是为了不打断聊天。

4. **防滥用：每个 Koishi 用户每天最多 3 条，两种来源合计。** 按 `Asia/Shanghai` 自然日计。超限时工具返回「今天的反馈次数已用完」：`requested` 由 LLM 转告用户，`observed` 直接放弃。被 `User.Flag.ignore` 标记的用户本来就到不了 LLM，不另做黑名单。
   Why：LLM 可能被话术绕过，也可能对同一个人过度主动，次数上限两头兜底。

5. **`feedback` 表。** 字段：`id`（自增）、`uid`（Koishi 用户 ID）、`platform`、`userId`（平台用户 ID）、`channelId`（私聊为空）、`source`、`title`、`summary`、`category`、`original`、`createdAt`、`handled`（布尔，默认 false）。

6. **控制台页面。** 表、工具注册和控制台页面放在同一个本地插件 `plugins/feedback` 里，通过 `ctx.llm.tools` 注册工具，页面结构照 `plugins/qqbot-admin`，需 authority 4。列表按时间倒序，默认只显示未处理的，可以切换显示全部；每条显示来源，可以标记为已处理或取消标记。
   Why：维护者只在 WebUI 查看，不需要推送。

## Acceptance

- 私聊或群里对 SILI 说一条具体的 bug，SILI 调用 `submit_feedback`，控制台反馈页出现这条，标题和摘要已润色，原话保留。
- 用户在聊天里抱怨某功能坏了但没说要反馈，表里出现一条 `observed` 记录，SILI 的回复不提反馈的事。
- 同一用户当天提交第 4 条时，工具返回已用完，SILI 告知用户，表里不新增。
- 发送 `feedback xxx`、`submit_feedback xxx` 不触发任何指令。
- 控制台里标记已处理后，这条从默认列表消失，切换「全部」后仍可见。
