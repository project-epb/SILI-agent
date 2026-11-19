# SILI 开发文档

这个文档主要是开发者写给自己看的备忘录，阅读此文档不一定能够让你在自己的服务器上成功部署 SILI。

## 指令速查

**启动服务**

```sh
docker-compose -p sili up -d
```

**停止服务**

```sh
docker-compose -p sili down
```

**重新构建**

```sh
docker-compose -p sili up -d --build
```

## 容器大纲

SILI 服务是基于 Docker 容器的，因此需要安装 Docker 以及 Docker Compose。

### sili-core

使用 [sili-core.dockerfile](../docker/sili-core.dockerfile) 构建。

基于 Ubuntu 22.04 镜像，安装了 Node.js LTS 和 pnpm。

HTML 渲染用的 Chrome 在独立的 `browser` 容器里（`docker/browser.dockerfile`），core 经 CDP 连接。

### sili-caddy

反代，将 80 端口的请求转发到 sili-core 容器的 3100 端口。

自动签发 Let's Encrypt 证书。

### sili-mongo

MongoDB 8.0 镜像。

**没有设密码，不能暴露 27017 端口到公网。**

### sili-llonebot

登录扫码：

```sh
docker logs -f sili-llonebot
```

VNC 端口是 `6788`，密码看 `.env` 文件 `VNC_PASSWD`。

**不能暴露 6700 端口到公网。**
