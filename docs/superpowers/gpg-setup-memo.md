# GPG + git-crypt 配置备忘

用 git-crypt 替代 dotenv-vault，在 mac/pc/production server 之间同步 .env 文件。

## 1. 安装

- macOS: `brew install gpg git-crypt`
- Linux: `apt install gnupg git-crypt`
- Windows: `scoop install gpg git-crypt`

## 2. 生成 GPG 密钥（任意一台设备，只需一次）

```bash
gpg --gen-key
# 记下输出中的 KEY_ID（也可以之后用 gpg --list-keys 查看）
```

## 3. 备份密钥 & 同步到其他设备

```bash
# 导出私钥（把 backup.asc 存到密码管理器里）
gpg --export-secret-keys -a <KEY_ID> > backup.asc

# 在其他设备上导入
gpg --import backup.asc
gpg --edit-key <KEY_ID> trust  # 信任级别选 5（ultimate）
```

个人项目所有设备共用一个密钥即可。

## 4. 在仓库中初始化 git-crypt（只需一次）

```bash
git-crypt init
git-crypt add-gpg-user <KEY_ID>
```

在 `.gitattributes` 中添加：
```
.env* filter=git-crypt diff=git-crypt
!.env.example filter= diff=
```

配置完成后，`git pull` 自动解密，`git push` 自动加密，无需额外命令。

其他设备 clone 后只需执行一次：
```bash
git-crypt unlock
```

## 5. GitHub 提交签名（绿色 Verified 徽章）

```bash
# 导出公钥，粘贴到 GitHub Settings -> SSH and GPG keys -> New GPG key
gpg --armor --export <KEY_ID>

# 开启自动签名
git config --global user.signingkey <KEY_ID>
git config --global commit.gpgsign true
```

可以和 git-crypt 用同一个 GPG 密钥，不冲突。

## 清理

配置完成后移除 dotenv-vault：
- `bun remove dotenv-vault`
- 删除 package.json 中的 `env:push` / `env:pull` 脚本
