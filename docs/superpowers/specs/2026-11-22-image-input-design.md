# SILI 读图

## Goal

SILI 看不到图片：收到的图只是一个 url 或占位符，系统提示词还要求她不得描述图里的内容。主流模型（含 DeepSeek）已原生多模态。让她直接看到用户发的图，并能按需查看聊天记录里的图。

## Scope

- In：OpenAI Responses 协议的服务商；图片按内容哈希落盘并按 LRU 淘汰；服务商 Files API 指针的上传、复用与过期；用户 @ 时附带的图直接进上下文；`view_image` 查看聊天记录里的图；不支持读图的服务商给出说明。
- Out：PDF、音视频；SILI 生成或发出的图回放给她看；表情包当图片发送（表情仍按名字给她）；单独的 `analyze_file` 工具。

## Decisions

### 协议

1. 新增服务商协议 `responses`（`LLM_PROVIDER_<i>_TYPE=responses`），生产的 DeepSeek 主服务商切到它。历史按 Responses 的条目重建：用户消息为 `input_text` / `input_image`，助手的工具调用为 `reasoning` + `function_call`，工具结果为 `function_call_output`（可含图片）。
   Why：只有 Responses 能用 `input_image.file_id` 引用 Files API 上传的文件（Chat Completions 传 `file_id` 实测报错）。主人已验证过 DeepSeek 在 Responses 下的缓存表现。

2. 思考模式下，每个工具调用前的思考内容作为 `reasoning` 条目（`reasoning_text`）原样回放；SILI 已存 `reasoning_content`。
   Why：DeepSeek 在思考模式下缺少它会返回 400（实测）。

### 图片存储

3. 收到的图片立即下载，按 sha256 存为宿主上的 `data/llm/images/<sha256>`（不在 Linux VM 里），另记 MIME 与尺寸。每次进上下文或被查看时刷新修改时间作为 LRU 时钟；定时清理删除超过 TTL（默认最近一次使用后 30 天）的文件，总量超过上限（默认 2 GiB）时从最久未用的开始删。单张超过 20 MiB 不收。
   Why：QQ 的图片链接会过期；内容寻址天然去重；反复发送的热门图会一直续命，只有总量上限能挡住硬盘被撑爆。照搬现有 `image-cache` 的 mtime-LRU 做法。

4. 模型可见的图片标识是 sha256 的前 12 位十六进制。
   Why：稳定、可去重，且不暴露消息 id 之外的内部信息。

### Files API

5. 服务商配置增加 `nativeFiles`（`LLM_PROVIDER_<i>_NATIVE_FILES=true`）。开启后，发图时查 Mongo 表 `llm_provider_file`（服务商、sha256、file_id、过期时间）：有至少还剩 1 小时的指针就直接引用；否则从本地读取上传，`purpose=user_data`，`expires_after` 为 7 天，保存返回的 `expires_at`。指针只属于上传它的服务商。上传遇到认证、限流或服务端错误照常报错，不悄悄改成内联。
   Why：照搬 only-chat：Files API 是服务商能力；带图的历史每轮重放，引用 file_id 比重复内联字节省得多。DeepSeek 实测支持 7 天过期并返回 `expires_at`。

6. 未开 `nativeFiles` 的服务商内联图片：Responses 用 `image_url` data URL，Chat Completions 用 `image_url`，Anthropic 用 base64 图片块。服务商配置增加 `vision`（`LLM_PROVIDER_<i>_VISION`，默认 false）；不支持读图的服务商，图片位置换成一句说明：有一张图，但当前模型看不到。

### 进入上下文

7. 用户消息（含被引用的那条消息）里的图片，在存入历史的信封里写成 `<image id="…" type="…" width="…" height="…"/>`；发送时由 provider 适配层展开成图片输入。表情包仍按现有方式以名字呈现，不当图片。
   Why：历史仍是文本，前缀稳定；展开只发生在发送前。

8. 展开时本地文件已被淘汰：有未过期的 file_id 仍可引用；两者都没有时，换成一句「这张图已过期」。
   Why：旧图不该让整段历史无法发送；这次变化只让前缀缓存失效一次。

9. `read_channel_history` 返回的消息里，图片同样写成 `<image id=…/>`（只写标识，不附图像）。新增工具 `view_image(ids)`，一次最多 4 张；只能查看本会话上下文里出现过的标识，未知标识返回找不到。工具结果本身只有文字（看了哪几张）；图片放在这批工具结果之后紧跟的一条 user 消息里，每张一组 `<tool_attachment call_id="…" image="…">` + 图片 + `</tool_attachment>`，这批工具结果全部返回后再追加。本轮追加与历史重建由同一构造器生成，两者逐字节一致。
   Why：群聊记录里的图大多无关，按需查看省 token。图片不放进工具结果：only-chat 踩过坑，部分模型和网关会把工具结果里的文件序列化成字节数组，模型看不到图还白占 token。

### 数量与尺寸

12. 一条用户消息最多附 4 张图的像素，按出现顺序取前 4 张；其余只以 `<image id …/>` 标签出现，并注明「这条消息共 N 张图，只附了前 4 张，其余可用 view_image 查看」。附哪几张在消息存入历史时就定下来，回放不变。
    Why：QQ 一条消息最多 30 张图，群友常发整话高清漫画；全附上会让一轮的 token 爆掉，并在之后每轮回放中反复计费。

13. `view_image` 每次最多 4 张，每轮合计最多 8 张，超出时返回错误说明，不附图。
    Why：同上，约束她自己按需查看时的开销。

14. 图片入库时缩到总像素不超过约 240 万（保持宽高比），转成 WebP（质量 85）后存储，不保留原图；GIF 只取第一帧。依赖新增 `sharp`。
    Why：图片 token 随像素增长，高清漫画单页常有数百万像素；按总像素而不是长边限制，长条漫画的字才不会被缩得看不清。

### 提示词

10. 删除「看不到图片内容」那条规则，改为：`<image>` 就是图片本身，可以描述；只依据看到的内容，不臆测看不清的细节。图片标识与 `view_image` 的说明作为一个插件段。

### Linux 机器

11. 开通 `linux` 的会话，图片同时照旧存进 `inbox/`，供她用工具处理。

## Acceptance

- 私聊发一张图问「这是什么」，SILI 能描述图的内容；下一轮追问同一张图，她仍能看到（历史回放）。
- 一条消息发 10 张图，模型请求里只带前 4 张，信封列出全部 10 个标识；`view_image` 能看到第 5 张。
- 一张 4000×6000 的图入库后不超过约 240 万像素、为 WebP。
- 同一张图连发两次，`data/llm/images` 里只有一个文件；Mongo 里同一服务商只有一条指针，第二次不再上传。
- 群聊里先有人发图、之后有人 @ SILI 问「刚才那张图是什么」，她调用 `read_channel_history` 找到图，再用 `view_image` 看到并回答。
- 把 TTL 或总量上限调小后运行清理，最久未用的图被删除；之后回放到它时显示「已过期」或改用仍有效的 file_id，请求不报错。
- 切到不支持读图的服务商，带图的历史能正常发送，图片处是说明文字。
- DeepSeek 在 Responses 下多轮工具调用不报 `reasoning_text` 错误；生产启动后系统提示词与工具列表的哈希跨重启一致。
