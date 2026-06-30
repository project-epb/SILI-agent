# Core image for SILI
FROM ubuntu:24.04

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

# 安装常用工具和软件包
RUN apt-clean-install \
    wget \
    curl \
    gnupg \
    zip \
    unzip \
    p7zip-full \
    git \
    fontconfig \
    ca-certificates

# 安装字体
RUN \
    # 汉仪文黑
    wget https://upy.epb.wiki/fonts/HYWenHei.7z && \
    7z x HYWenHei.7z -oHYWenHei && \
    mv HYWenHei/*.ttf /usr/share/fonts/truetype/ && \
    rm -rf HYWenHei HYWenHei.7z && \
    # Segoe UI Emoji
    wget https://upy.epb.wiki/fonts/seguiemj.ttf && \
    mv seguiemj.ttf /usr/share/fonts/truetype/ && \
    # 刷新字体缓存
    fc-cache -fv

# 安装 Node.js LTS 以及 bun（钉死 bun 版本，保证镜像可复现；安装脚本靠首位置参数选版本）
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && \
    apt-clean-install nodejs && \
    curl -fsSL https://bun.com/install | bash -s "bun-v1.3.14"

# 将 bun 添加到 PATH
ENV PATH="/root/.bun/bin:${PATH}"

# 安装 Node.js 依赖
COPY package.json bun.lock .npmrc ./
RUN PUPPETEER_SKIP_DOWNLOAD=true bun install --frozen-lockfile

# 使用 puppeteer 安装 Chrome
VOLUME /root/.cache/puppeteer
# https://pptr.nodejs.cn/guides/configuration
ENV PUPPETEER_DOWNLOAD_BASE_URL="https://cdn.npmmirror.com/binaries/chrome-for-testing"
RUN DEBUG=puppeteer:* bun puppeteer browsers install chrome --base-url "$PUPPETEER_DOWNLOAD_BASE_URL"
# https://source.chromium.org/chromium/chromium/src/+/main:chrome/installer/linux/debian/dist_package_versions.json
RUN apt-clean-install \
    libasound2t64 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libudev1 libuuid1 libx11-6 libx11-xcb1 libxcb-dri3-0 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxkbcommon0 libxrandr2 libxrender1 libxshmfence1 libxss1 libxtst6

# SILI，启动！
CMD ["bun", "start"]
