# Shared browser for SILI: chrome-headless-shell + fonts + the supervisor
# (docker/browser/supervisor.ts), which is the only way in. sili-core connects
# over CDP; see docs/superpowers/specs/2026-11-19-shared-browser-design.md.
#
# CHROME_VERSION must be the chrome-headless-shell version that core's locked
# puppeteer-core declares (node_modules/puppeteer-core/lib/esm/puppeteer/revisions.js).
# Bump both together: CDP follows Chrome, and puppeteer is only tested against
# that one version.

FROM ubuntu:noble-20260610 AS base

ENV DEBIAN_FRONTEND=noninteractive
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

ENV APT_SOURCE_MIRROR="mirrors.aliyun.com"
RUN sed \
    -e "s|archive.ubuntu.com|${APT_SOURCE_MIRROR}|g" \
    -e "s|security.ubuntu.com|${APT_SOURCE_MIRROR}|g" \
    -e "s|ports.ubuntu.com|${APT_SOURCE_MIRROR}|g" \
    -i.bak /etc/apt/sources.list.d/ubuntu.sources

COPY /scripts/apt-clean-install.sh /usr/local/bin/apt-clean-install
RUN chmod +x /usr/local/bin/apt-clean-install


# ---------------------------------------------------------------------------
# 字体：渲染结果取决于字体，必须和浏览器在同一个镜像里。
# 下载解压只在构建阶段发生，最终镜像只拿 .ttf。
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
# Chrome for Testing 的 headless shell，经国内镜像下载。
# ---------------------------------------------------------------------------
FROM base AS chrome

ARG CHROME_VERSION=143.0.7499.40
RUN apt-clean-install wget ca-certificates unzip
RUN wget -q "https://cdn.npmmirror.com/binaries/chrome-for-testing/${CHROME_VERSION}/linux64/chrome-headless-shell-linux64.zip" && \
    unzip -q chrome-headless-shell-linux64.zip && \
    mv chrome-headless-shell-linux64 /opt/chrome


# ---------------------------------------------------------------------------
# bun：版本与 core 镜像一致。
# ---------------------------------------------------------------------------
FROM base AS bun-installer

RUN apt-clean-install curl ca-certificates unzip
RUN curl -fsSL https://bun.com/install | bash -s "bun-v1.4.2"


# ---------------------------------------------------------------------------
# 运行时镜像
# ---------------------------------------------------------------------------
FROM base

RUN apt-clean-install fontconfig ca-certificates

COPY --from=fonts /fonts/*.ttf /usr/share/fonts/truetype/
RUN fc-cache -fv

# Chrome 的系统依赖库。libgbm1 会拉进 mesa + libllvm（约 178 MB），是 headless
# Chrome 的软件渲染栈，删了 HTML 渲染就废了，不要动。
# https://source.chromium.org/chromium/chromium/src/+/main:chrome/installer/linux/debian/dist_package_versions.json
RUN apt-clean-install \
    libasound2t64 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libudev1 libuuid1 libx11-6 libx11-xcb1 libxcb-dri3-0 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxkbcommon0 libxrandr2 libxrender1 libxshmfence1 libxss1 libxtst6

COPY --from=chrome /opt/chrome /opt/chrome
COPY --from=bun-installer /root/.bun/bin/bun /usr/local/bin/bun
COPY /docker/browser/supervisor.ts /app/supervisor.ts

RUN useradd --create-home --uid 10001 browser
USER browser
WORKDIR /app

EXPOSE 3000
CMD ["bun", "/app/supervisor.ts"]
