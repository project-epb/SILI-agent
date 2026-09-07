# Core image for SILI
#
# 这是一个**纯运行时基座**，不是打包好的应用：镜像里只有 OS、字体、Chrome 的
# 系统依赖库和 bun。应用代码由 compose 挂载，node_modules 和 Chrome 本体都活在
# named volume 里，由 scripts/docker-entrypoint.sh 在每次启动时对齐。
#
# 不要把 node_modules 或 Chrome 装回镜像：
#   - node_modules 会让镜像随 package.json 一起失效，且被 volume 遮蔽后毫无用处；
#   - Chrome 装进镜像后，puppeteer 一升级就必须重新打包整个镜像才能换浏览器。
# 只有"跟着 apt 走、以年为单位变动"的东西才该留在这里。

FROM ubuntu:24.04 AS base

WORKDIR /app
ENV DEBIAN_FRONTEND=noninteractive
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

ENV APT_SOURCE_MIRROR="mirrors.aliyun.com"
RUN sed \
    -e "s|archive.ubuntu.com|${APT_SOURCE_MIRROR}|g" \
    -e "s|security.ubuntu.com|${APT_SOURCE_MIRROR}|g" \
    -e "s|ports.ubuntu.com|${APT_SOURCE_MIRROR}|g" \
    -i.bak /etc/apt/sources.list.d/ubuntu.sources

# 配置辅助工具
COPY /scripts/apt-clean-install.sh /usr/local/bin/apt-clean-install
RUN chmod +x /usr/local/bin/apt-clean-install


# ---------------------------------------------------------------------------
# 字体：下载解压只在构建阶段发生，最终镜像只拿 .ttf，
# 不背 wget / p7zip-full / unzip 这些纯构建期工具。
# ---------------------------------------------------------------------------
FROM base AS fonts

RUN apt-clean-install wget ca-certificates p7zip-full unzip

WORKDIR /fonts
RUN \
    # 汉仪文黑
    wget https://upy.epb.wiki/fonts/HYWenHei.7z && \
    7z x HYWenHei.7z -oHYWenHei && \
    mv HYWenHei/*.ttf /fonts/ && \
    rm -rf HYWenHei HYWenHei.7z && \
    # Segoe UI Emoji
    wget https://upy.epb.wiki/fonts/seguiemj.ttf && \
    # JetBrains Mono（英文等宽，代码块渲染用；CJK 仍走汉仪文黑）
    wget https://upy.epb.wiki/fonts/JetBrainsMono-2.304.zip && \
    unzip -q JetBrainsMono-2.304.zip -d JetBrainsMono && \
    find JetBrainsMono -name '*.ttf' -exec mv {} /fonts/ \; && \
    rm -rf JetBrainsMono JetBrainsMono-2.304.zip


# ---------------------------------------------------------------------------
# bun：官方安装脚本要用 unzip 解包，装在独立阶段避免把 unzip 带进运行时镜像。
# 版本钉死，保证镜像可复现（安装脚本靠首位置参数选版本）。
# ---------------------------------------------------------------------------
FROM base AS bun-installer

RUN apt-clean-install curl ca-certificates unzip
RUN curl -fsSL https://bun.com/install | bash -s "bun-v1.4.2"


# ---------------------------------------------------------------------------
# 运行时镜像
# ---------------------------------------------------------------------------
FROM base

# git 是运行时依赖，别删：`version` 命令要跑 `git rev-parse --short HEAD` 读
# commit hash（.git 由 compose 挂载进来）。它会带进 perl，约 76 MB。
RUN apt-clean-install \
    curl \
    git \
    fontconfig \
    ca-certificates

COPY --from=fonts /fonts/*.ttf /usr/share/fonts/truetype/
RUN fc-cache -fv

COPY --from=bun-installer /root/.bun /root/.bun
ENV PATH="/root/.bun/bin:${PATH}"

# entrypoint 里 `puppeteer browsers install` 靠这个变量走国内镜像
# https://pptr.nodejs.cn/guides/configuration
ENV PUPPETEER_DOWNLOAD_BASE_URL="https://cdn.npmmirror.com/binaries/chrome-for-testing"

# Chrome 的系统依赖库。Chrome 本体不在镜像里（见文件头），但这些 .so 必须在。
# 其中 libgbm1 会拉进 mesa + libllvm20（约 178 MB），是本镜像最大的单块——
# 那是 headless Chrome 的软件渲染栈，删了 HTML 渲染就废了，不要动。
# https://source.chromium.org/chromium/chromium/src/+/main:chrome/installer/linux/debian/dist_package_versions.json
RUN apt-clean-install \
    libasound2t64 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libudev1 libuuid1 libx11-6 libx11-xcb1 libxcb-dri3-0 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxkbcommon0 libxrandr2 libxrender1 libxshmfence1 libxss1 libxtst6

COPY /scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint
RUN chmod +x /usr/local/bin/docker-entrypoint

WORKDIR /app

# SILI，启动！
CMD ["docker-entrypoint"]
