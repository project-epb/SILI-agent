# Core image for SILI
#
# 这是一个**纯运行时基座**，不是打包好的应用：镜像里只有 OS、git 和 bun。
# 应用代码由 compose 挂载，node_modules 活在 named volume 里，由
# scripts/docker-entrypoint.sh 在每次启动时对齐。
#
# 不要把 node_modules 装回镜像：它会让镜像随 package.json 一起失效，且被 volume
# 遮蔽后毫无用处。浏览器、字体和渲染依赖在 browser 镜像（docker/browser.dockerfile），
# 不要加回这里。
# 只有"跟着 apt 走、以年为单位变动"的东西才该留在这里。

# Dated tag, not the floating `24.04`: rebuilds must not silently pick up a new
# base. Bump deliberately.
FROM ubuntu:noble-20260610 AS base

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
    ca-certificates

COPY --from=bun-installer /root/.bun /root/.bun
ENV PATH="/root/.bun/bin:${PATH}"

COPY /scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint
RUN chmod +x /usr/local/bin/docker-entrypoint

WORKDIR /app

# SILI，启动！
CMD ["docker-entrypoint"]
