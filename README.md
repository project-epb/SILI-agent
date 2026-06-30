<div align="center">

<img src="https://r2.epb.wiki/avatar/SILI.jpg" alt="SILI avatar" width="200"/>

# SILI-agent

The S-I-L-I Network: harder, better, faster, stronger.

</div>

隶属于万界规划局项目组的聊天机器人，一个人工智能小萝莉、一个笨蛋。

名字是 **The data transmission network with Spatiotemporal Isomorphic and Limitless Interdimensional** (_The S-I-L-I Network_) 的缩写。

<div align="right">

[查看 SILI 的角色设定](https://epb-wiki.notion.site/sili-network)

</div>

## SILI Powered

### 向 SILI 直截了当地提出问题吧！

<img src="https://github.com/project-epb/SILI-agent/assets/44761872/79e1ac41-c147-48a2-9f0a-11c8fba5b696" width="350">

<div align="right">—— AI powered ☆ 生动有趣又偶尔生草</div>

### 让 SILI 教教你外语怎么说！

<img src="https://github.com/project-epb/SILI-agent/assets/44761872/54433e6b-790b-4f7e-a29f-00eacea1504f" width="350">

<div align="right">—— 月が绮丽ですね</div>

### ~~就要涩涩！~~ 只是搜图而已啦！

<img src="https://github.com/project-epb/SILI-agent/assets/44761872/fc420e88-caea-4ece-a0b6-367e33d425d3" width="350">

<div align="right">—— SILI sama~ Can can word~!</div>

## 常用指令

可以通过 `@SILI <command>` `sili，<command>` 或者 `!<command>` 使用 SILI 的指令。不过许多指令带有别名和容易记住的中文捷径。

全部指令以及使用说明可以通过`!help`获取。

### `wiki <pagename>`

使用频道绑定的 MediaWiki 网站返回 wiki 的页面信息与链接。

例如 `[[Help:Content]]` → https://community.fandom.com/zh/wiki/Help:Content

Fandom 的全域跨语言链接同样适用，例如 `[[w:c:zh.ngnl:初濑伊纲]]` → https://ngnl.fandom.com/zh/wiki/%E5%88%9D%E6%BF%91%E4%BC%8A%E7%BA%B2

### `sticker`

生成奇怪的表情包！

### ~~`genshin`~~

查询《原神》玩家信息。

- `我的原神信息` 展示你的游戏信息卡
- `原神角色xxx` 炫耀你的角色
- `原神深渊` 查看深境螺旋通关情况

### `youdao`

使用无道词典进行翻译，支持超过一百种语言互译！

- 极简自动翻译：`sili，hello world是什么意思`
- 快速中外翻译：`sili，你好用埃塞俄比亚语怎么说`
- 指定语言互译：`sili，英语hello world用日语怎么说`

### `pixiv`

快速查看 P 站插画！

`!pixiv 123456`

### `bilibili`

查询 b 站用户，一键单推主播！

- 查用户：`查b站用户xxx`
- 查直播间：`查b站xxx的直播间`
- 直播间订阅：`单推b站主播xxx`

## 更多有趣的功能

发送`sili，帮助`即可查看完整的帮助！

**PRs Welcome** —— 想到了什么有意思的功能？欢迎提交 Issues 或直接 PR！

## 开发指南

**快速启动**

```sh
docker compose up -d
```

**运行时**：源码以 TypeScript + 最新 ECMAScript 规范编写，由 **bun** 直接执行（dev 与生产统一、无编译步骤），bun 同时充当包管理器。

> ⚠️ `package.json` 显式声明 `"type": "commonjs"`。koishi 的加载器依赖 CJS 的 `require.extensions`，**请勿改为 `"type": "module"`**，否则启动即失败。

详见 [开发文档](docs/README.md)。

---

> MIT License
>
> Copyright (c) 2022 万界规划局(Every Planing Bureau) / 机智的小鱼君(Dragon-Fish)
