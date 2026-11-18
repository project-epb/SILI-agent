# 功能开关（feature）

## Goal

v5 里「某个功能在哪能用」由四套互相打补丁的机制决定：koishi-plugin-switch 的按群开关、给它补漏的 `SilentSwitch`、qqbot 门控里写死的免激活白名单（还要和 profile 里的 `PluginCollectionPublic` 手动同步）、ComfyUI 自带的频道白名单。新增一个要小范围开放的功能（ComfyUI）就得改 env 再重启。用一个自己的 `feature` 插件取代它们，像灰度开关一样按档位管理功能。

## Scope

- In：`feature` 插件与指令；三个档位；群激活的入口并入 `feature`；控制台按群开关功能；门控的放行名单改由档位推出；LLM 指令目录按会话过滤；ComfyUI、NovelAI 改为高级档；删掉 koishi-plugin-switch（v5）、`SilentSwitch`、`channel.activate`、ComfyUI 的 `allowedChannels`、NovelAI 的频道参数。
- Out：激活的存储和连带逻辑（`qqbot_channel.activated`、served 上下文、首次激活通知、群迁移、被移出群取消激活）照旧；私聊激活（`qqbot_user.dmActive`、`user.activate`、控制台私聊开关）照旧；v4 profile 保持原样；在控制台修改档位。

## Decisions

1. **群的档位就是激活状态：未激活 = public，已激活 = 标准；每个功能再在档位基础上单独开关。功能默认是标准档。**
   - `public`：任何群和私聊都能直接用，不需要激活（试用模式）。
   - 标准档（不标记）：群或私聊激活后可用。
   - `premium`：默认关，必须在该群或私聊里单独打开；未激活的群里打不开。
   Why：精选功能给所有人试用，大部分功能后台激活一下就能用，贵的或要小范围灰度的功能逐群开放。

2. **档位跟着指令声明。** 自己的插件在 `ctx.command` 的配置里写 `feature: 'public' | 'premium'`；第三方插件的指令由 profile 在 `feature` 插件的配置里按指令名列出档位。子指令继承父指令的档位，可以自己再声明覆盖。
   Why：档位写在功能旁边，不再有两处要手动同步的名单。

3. **按群开关存在频道的 `enable` / `disable` 列表里**（字段沿用 switch 的，现有数据不迁移）。`disable` 关掉 public 或标准档的指令，`enable` 打开 premium 指令。判定沿父指令链向上：任一层被关就关，premium 要在 `enable` 里出现才开。私聊同样适用，存在该私聊的频道行上。

4. **指令是 `feature`，别名「功能」。**
   - `feature`：第一行是本群档位（试用 / 已激活），之后列出单独打开和关闭的功能。
   - `feature -e <指令...>` / `feature -d <指令...>`：打开 / 关闭；`-r <指令...>` 恢复默认。
   - `feature -a`：激活本群；`feature -a -r`：取消激活。调用 qqbot 现有的激活逻辑，取代 `channel.activate`（含别名「激活」），门控在未激活群里给 op 放行它。
   - 关闭 public / 标准档：权限 3。打开或关闭 premium、激活与取消激活：权限 4（op）。只能操作权限不高于自己的指令。
   - 私聊里 `feature` 只管单个功能的开关，`-a` 不可用；私聊激活仍用 `user.activate`。
   Why：激活就是群的档位，与功能开关放在同一个入口；花钱的功能只有 op 能放，日常功能群管理员能自己关。私聊激活牵连多，暂不动。

5. **没开的功能：人直接调用时静默，SILI 调用时说明原因。** 消息直接解析成指令的路径静默丢弃；经 `session.execute` 进来的调用（LLM 工具、shortcut、兜底转 chat）返回一句给模型看的说明（本群没开放、不要重试），不发到群里。
   Why：静默能避免在关掉功能的群里刷屏；但 LLM 拿到空结果会编造「画好了」，必须告诉它。

6. **LLM 的指令目录按会话过滤**，没开的指令不进目录。目录随群不同，系统提示按目录缓存。
   Why：SILI 看不到就不会去调，省 token，也不会被群友诱导。

7. **门控的免激活放行名单由档位推出。** 未激活的群和私聊里，public 档的指令（含别名、子指令）放行，其余照旧在 Koishi 处理之前丢弃。op 专用的 `channel.activate`、群迁移、私聊的 `bind` 不是功能，仍由门控单独放行。`[[词条]]` 链接照旧放行。私聊里用不了的指令（`wiki`、`github`）由各自的插件处理，不再单独维护私聊名单。
   Why：门控在建用户、建频道行之前丢消息，防陌生群撑满数据库，要保留；变的只是名单的来源。

8. **控制台按群开关功能。** 频道管理器（`qqbot-admin`）每个群和私聊行有「功能」面板：群的面板顶部是激活开关，下面按档位列出全部功能，每项显示默认 / 已打开 / 已关闭，可开关、可恢复默认。档位只读，只在代码里声明。`feature` 服务提供「列出频道的功能状态」和「修改开关」两个方法，指令和控制台都调它们。
   Why：开关在网页上点比进群敲指令方便；档位是功能的属性，网页上能改就会和代码各说各话。

9. **public 档指令所在的插件仍须装在 profile 的 public 上下文里。** `feature` 启动后检查：声明为 public 的指令若注册在只服务已激活会话的上下文里，记一条错误日志。
   Why：插件装在哪个上下文决定它能不能收到未激活会话，`feature` 只能判定、不能替它收消息。

10. **ComfyUI 和 NovelAI 是 premium。** 上线后在小鱼君测试沙盒、艾尔奇亚联邦国立金属研究所（NGNL 闲聊群）和小鱼君的私聊里打开 ComfyUI。

## Acceptance

- 未激活群：`help`、`dice`、`wiki` 能用；聊天、pixiv 没反应；`[[词条]]` 照常展开。
- 已激活群：标准档功能可用；`comfyui.generate` 没反应，让 SILI 画图时它说本群没开放画图。
- op 在未激活群里 `feature -a` 后标准档功能可用，`feature -a -r` 后回到只有 public；`channel.activate` 不再存在。
- 控制台打开某群的「功能」面板能看到档位和每个功能的状态，在面板里开关的效果与指令相同。
- op 在群里 `feature -e comfyui` 后可以画图；`feature -r comfyui` 后恢复关闭。权限 3 的用户执行 `feature -e comfyui` 被拒绝。
- `feature -d chat` 后该群和 SILI 聊天没反应；之前用 switch 关掉的功能上线后仍然是关的。
- 小鱼君私聊 `feature -e comfyui` 后可以画图，别人的私聊不行。
- 已激活但没开 ComfyUI 的群，SILI 的系统提示里没有 `comfyui` 指令。
- v5 不再加载 koishi-plugin-switch 和 `SilentSwitch`，代码里没有写死的免激活名单和 ComfyUI 频道白名单。
