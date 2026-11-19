# 共享浏览器服务（browser）

## Goal

sili-core 现在用 koishi-plugin-puppeteer 在自己容器里常驻一个 Chrome：core 镜像因此要背字体和约 178 MB 的 Chrome 渲染依赖，Chrome 本体占一个 volume，core 的内存里有一大块是浏览器，重启 core 浏览器也跟着重来。之后的 Linux 沙盒也要用浏览器，那台 2 核 3.5G 的机器跑不起多个 Chromium。把 Chromium 拆成独立容器，core 和以后的沙盒共用。

## Scope

- In：`browser` 容器（Chrome + 守护进程）；core 侧替换 koishi-plugin-puppeteer 的 `puppeteer` 服务；`file://` 模板改走请求拦截；浏览器网络隔离；core 镜像与 entrypoint 去掉 Chrome、字体和渲染依赖。v4、v5 两个 profile 都改用新服务。
- Out：沙盒接入（按沙盒发 token、context 归属隔离、浏览器访问沙盒容器），在 `feat/linux-sandbox` 里做；浏览器走 mihomo 出站代理。

## Decisions

1. **`browser` 是 sili compose 里的一个服务，镜像自己构建**：Ubuntu noble 基座 + Chrome for Testing 的 `chrome-headless-shell` + 字体 + bun 跑的守护进程。字体（汉仪文黑、Segoe UI Emoji、JetBrains Mono）和 Chrome 系统依赖从 core 镜像整段搬过来；Chrome 在构建时经 npmmirror 下载并装进镜像。
   Why：渲染结果取决于字体，字体必须和浏览器在一起；浏览器镜像只为跑 Chrome 存在，没有 core 那种「puppeteer 一升级就要重打镜像」的顾虑。
   Rejected：browserless —— 默认每个连接新起一个 Chrome，正好与 core「常驻一个浏览器、只开关页面」的用法相反；页面清理、回收这些我们要的策略它也不按我们的方式做。

2. **Chrome 版本由 core 锁定的 `puppeteer-core` 决定**：镜像构建参数里写死该版本声明的 Chrome 版本，两者一起升。
   Why：CDP 协议跟着 Chrome 走，puppeteer 只对它声明的那个版本做过测试。

3. **守护进程是 Chrome 的唯一入口**。Chrome 只监听容器内 `127.0.0.1:9222`；守护进程监听 `0.0.0.0:3000`：
   - `GET /health`：Chrome 存活时返回 200。
   - WebSocket `/?token=<BROWSER_TOKEN>`：token 正确就转发到 Chrome 的 browser 端点，否则 401。多个客户端可以同时连接。
   - Chrome 退出即重启；重启时断开所有客户端连接。
   Why：Chrome 的调试端口不校验身份，也拒绝非 IP 的 Host 头，必须有一层代理；守护进程还要承担第 4、5 条。token 现在只有 core 一个用户，但沙盒接入时直接沿用这个口子。

4. **守护进程兜底清理**：自己保持一个 CDP 连接，订阅 target 事件，记录每个 page 和 browser context 的创建时间，每 10 秒扫一次：
   - 存活超过 `PAGE_MAX_AGE`（120 秒）的 page 直接关掉；
   - 已经没有 page、且已存在超过 30 秒的 browser context 直接销毁。
   Why：调用方漏关页面（插件自带的 `render()` 就没把 `close()` 放进 `finally`）在浏览器常驻之后会一直累积；之前靠 core 重启顺带清掉，拆出去以后这条路没了。

5. **守护进程定期回收 Chrome**：没有打开的 page，并且「Chrome 已运行超过 6 小时」或「Chrome 进程总 RSS 超过 600 MB」时重启 Chrome。容器 `mem_limit` 1g。
   Why：长跑的 Chromium 内存只涨不跌；只在空闲时重启，不会打断正在截的图；失控时被 OOM 的只有浏览器容器。

6. **core 的 `puppeteer` 服务换成自己写的**，服务名和 `page()` 接口不变，现有调用方（HTMLService、mediawiki、sticker）不用改：
   - 启动时 `puppeteer.connect` 到 `BROWSER_ENDPOINT`（`ws://browser.sili.local:3000/?token=…`），断开后标记失联，下一次 `page()` 时重连；重连失败就抛错给调用方。
   - `page()` 每次新建一个 browser context 再在里面开页面，`page.close()` 时连同 context 一起关掉。
   - 同时打开的页面上限 3 个，多出的排队。
   - 不提供 koishi-plugin-puppeteer 的 `render`、`svg`、`<html>` 组件和 canvas：代码里没有使用。
   - `puppeteer` 依赖换成 `puppeteer-core`。
   Why：koishi-plugin-puppeteer 只会 `launch`，不会 `connect`。每页一个 context，cookie 和存储不会在不同任务之间串，关闭也能连带清掉弹窗、子页面。调用方的 catch 已经能处理截图失败，失联时直接报错就够了。

7. **`file://` 模板改走请求拦截**。HTMLService 收到 core `src/` 下的 `file:` URL 时，改写成 `http://sili-local.invalid/<相对 src 的路径>?<原 query>`，并用 CDP `Fetch.enable` 只拦截这个 origin：请求从 core 本地磁盘读文件响应，Content-Type 按扩展名给出；路径越出 `src/` 返回 403。其他请求不经过 core。
   Why：浏览器在另一个容器里，读不到 core 的文件（蔚蓝档案、喜报悲报、梅因说、user-infobox 都是本地 `index.html` 加相对路径的图片）。拦截不需要给 core 开任何新路由，也不需要两个容器共享卷。
   Rejected：core 开一个内网静态路由 —— 那要给浏览器放行到 core 的连接，与第 8 条的封锁冲突；把 `src/` 挂进浏览器容器 —— 两个容器的路径要保持一致，而且浏览器能读到全部源码。

8. **浏览器与内网隔离**：
   - `browser` 只连一个独立网络 `sili-browser`（固定子网），不进 `sili-network`；core 同时加入两个网络，在 `sili-browser` 里的别名是 `core.sili.local`。浏览器直接出站，与现状一致。
   - 宿主防火墙脚本放在仓库 `scripts/`，用 systemd oneshot 在 docker 启动后执行，重复执行结果不变：来自 `sili-browser` 子网的流量，放行已建立的连接；去往 RFC1918、`100.64.0.0/10`（含阿里云元数据 `100.100.100.200`）、`169.254.0.0/16` 的一律丢弃（DOCKER-USER 链）；到宿主本机的一律丢弃（INPUT 链）。
   Why：`screenshot` 指令能让浏览器打开任意 http(s) URL。现在的 Chrome 在 core 容器里，能直接访问 mongo、napcat 和元数据地址，这是一个已经存在的 SSRF 口子；沙盒接入后，浏览器更会被任意代码驱动。

9. **`screenshot` 的 `-t` 超时最大 90 秒**。
   Why：要短于第 4 条的 120 秒，免得截图还没完成，页面就被守护进程关掉。

10. **core 镜像变瘦**：删掉 fonts 阶段、Chrome 系统依赖、`PUPPETEER_DOWNLOAD_BASE_URL`；entrypoint 不再安装 Chrome；删掉 `sili_puppeteer_cache` 卷。core `depends_on: browser`。
    Why：这些只为本地 Chrome 存在。`mesa`/`libllvm` 是 core 镜像里最大的一块。

## Acceptance

- 生产上 sili-core 进程树里没有 chrome；`markdown`、`hljs`、`screenshot`、mediawiki 信息框、四个 sticker 和 user-infobox 截图正常，中文和 emoji 字形与现在一致。
- 对一个页面不调用 `close()`，120 秒后它在 `browser` 里被关掉；context 随后被销毁。
- `docker restart sili-browser` 之后，下一次截图无需重启 core 就能成功。
- 在 `browser` 容器里访问 `mongo.sili.local` 解析失败；访问 `172.18.0.0/16` 内的地址、`100.100.100.200`、宿主网关全部不通；访问公网 https 正常；宿主重启后这些规则仍然生效。
- 不带 token 或 token 错误时连接 WebSocket 返回 401。
- 新 core 镜像比旧镜像小（记录前后体积）；core 空闲内存比现在的 497 MiB 低。
