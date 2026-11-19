# Codex 任务同步：配置与部署教程

[English](task-sync.md) · [返回 README](README.zh-CN.md)

任务同步把**勾选的 Codex 会话和对应 Git 项目状态**带到另一台电脑。会话 ID、本地附件、Git 提交、暂存/未暂存改动及未跟踪文件会一起传输；每台电脑首次选择本地项目位置。账号/API 配置各自保留，不随任务复制。

## 1. 先确定使用哪种存储

| 你已有的服务 | 在 easy-switch 中选择 | 需要准备 |
| --- | --- | --- |
| Zotero 账号，附件使用 **Zotero Storage** | 暂不能直接接入 | 另外准备 WebDAV 或自己的服务器 |
| Zotero 的附件已经使用 **WebDAV** | **WebDAV** | 原 WebDAV 服务地址、用户名、应用密码；新建独立目录 |
| Nextcloud、NAS 或其他 WebDAV 服务 | **WebDAV** | 服务提供的 WebDAV 地址和凭据 |
| 一台可 SSH 登录的服务器，没有域名 | **自建服务器** | 部署同步服务，在每台电脑建立 SSH 隧道 |
| 服务器和域名，希望各电脑直接联网同步 | **自建服务器** | 部署同步服务、域名和 HTTPS |

Zotero 的“文献数据同步”和“附件文件同步”是不同功能；附件可以使用 Zotero Storage，也可以使用第三方 WebDAV。easy-switch 复用的是 **WebDAV 协议和存储服务**，不会读取 Zotero 文献库，也不能把 Zotero 账号或 Zotero API Key 当作 WebDAV 凭据。[Zotero 官方说明](https://www.zotero.org/support/sync)

## 2. 已在 Zotero 使用 WebDAV，如何添加

### 找到真正的 WebDAV 配置

1. 打开 Zotero 的**设置 → 同步 → 文件同步**。系统/版本不同，入口名称可能略有差别。
2. 检查“个人文献库的附件同步”选择的是 **WebDAV** 还是 **Zotero Storage**。
3. 如果是 WebDAV，记下存储服务商、地址和用户名。密码应从服务商处获取或重新创建应用密码，不需要导出 Zotero 数据。
4. 如果是 Zotero Storage，你还没有可供 easy-switch 使用的 WebDAV，先准备 WebDAV 服务或按第 3 节部署服务器。

### 新建独立目录

在 WebDAV 服务的网页文件管理器或 NAS 中，新建一个 `easy-switch` 文件夹。**不要把 easy-switch 的文件放进 Zotero 管理的 `zotero` 附件目录。**

例如，存储目录应类似：

```text
WebDAV 根目录/
├── zotero/        # 保留给 Zotero
└── easy-switch/   # 新建，交给 easy-switch
```

地址必须包含 `https://` 和完整目录。Zotero 可能把协议与路径分开显示，或自动使用 `zotero` 子目录；不要直接把它的整栏内容原样拼到 easy-switch。

以下是**填写格式示例，不是已经替你创建好的地址**：

| WebDAV 类型 | easy-switch 服务器地址示例 |
| --- | --- |
| 通用服务 | `https://dav.example.com/easy-switch/` |
| Nextcloud | `https://cloud.example.com/remote.php/dav/files/alice/easy-switch/` |
| NAS 自定义路径 | 按 NAS 提供的 HTTPS WebDAV 根地址，加上独立文件夹路径 |

Nextcloud 的真实 WebDAV 地址可以在“文件设置 → WebDAV”找到；第三方客户端使用应用密码，具体入口见 [Nextcloud 官方教程](https://docs.nextcloud.com/server/latest/user_manual/en/files/access_webdav.html)。其他服务以其控制台给出的地址为准，不要填分享链接或网盘网页地址。

### 在第一台电脑填写

打开 easy-switch → **设置 → 任务同步 → 存储配置**：

| 字段 | 填什么 |
| --- | --- |
| 存储类型 | **WebDAV** |
| 服务器地址 | 刚建好的 `easy-switch/` 目录的完整 HTTPS WebDAV URL |
| 用户名 | WebDAV 服务的用户名 |
| WebDAV 应用密码 | WebDAV 服务颁发的应用密码或协议专用密码 |
| 共享加密口令 | 自己设置的至少 12 字符口令；每台电脑必须一致，与 WebDAV 密码是两回事 |
| 自动同步 | 开启 |

点击**验证并保存**。成功后自动进入“同步任务”，勾选要同步的会话。没有勾选的本机会话不会上传。等待任务显示“已同步”。

验证会检查目录读写、ETag 和条件写入。**Zotero 验证成功不等于 easy-switch 必然兼容**：easy-switch 还要求 `If-Match` / `If-None-Match` 能阻止并发覆盖。不满足时会明确拒绝保存，不能通过关闭检查来绕过。

## 3. 使用自己的服务器，如何添加

服务器上需要运行本项目的同步服务，不能只在客户端填写服务器 IP、SSH 地址或数据库地址。服务把加密任务包保存到 SQLite，客户端通过 HTTP(S) 访问，**不用安装数据库驱动或开放数据库端口**。

下面以 Linux 服务器为例。先安装 Git、[Docker Engine](https://docs.docker.com/engine/install/) 和 [Compose 插件](https://docs.docker.com/compose/install/linux/)；运行 `docker compose version` 确认可用。后续 Docker 命令需要有访问 Docker 的权限。没有 Docker 时见本节末尾的 Node.js 方式。

### 3.1 下载部署文件并生成访问令牌

以你自己的服务器用户执行：

```bash
git clone https://github.com/JasperRoc/easy-switch.git
cd easy-switch/docs/sync-server
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

复制最后一条命令生成的随机字符串，编辑当前目录的 `.env`：

```dotenv
SWITCH_SYNC_TOKEN=粘贴生成的随机字符串
SYNC_DOMAIN=sync.example.com
```

`SWITCH_SYNC_TOKEN` 是客户端连接服务的密码；**共享加密口令另外在客户端设置**。两者不要混淆，也不要把 `.env` 提交到 Git。没有域名、使用 SSH 隧道时，`SYNC_DOMAIN` 不会被启用。

### 3.2 方案 A：没有域名，通过 SSH 隧道连接

在服务器的 `docs/sync-server` 目录执行：

```bash
docker compose up -d --build sync
docker compose ps
docker compose logs --tail=50 sync
```

日志应出现 `easy-switch sync server listening on port 18445`。服务仅映射到服务器的 `127.0.0.1:18445`，不会公开暴露这个端口。

在**每台使用 easy-switch 的电脑**的终端执行：

```bash
ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -L 127.0.0.1:18445:127.0.0.1:18445 user@your-server
```

把 `user@your-server` 换成你的 SSH 用户和服务器地址，也可以使用已经配置的 SSH 别名。Windows PowerShell 请把命令写在一行。终端没有输出通常表示隧道已经建立；保持该进程运行，关闭它会断开同步连接。若本机端口被占用，把 `-L` 的第一个 `18445` 改为 `18446`，客户端地址也相应改为 `http://127.0.0.1:18446/`。

客户端填写：

| 字段 | 值 |
| --- | --- |
| 存储类型 | **自建服务器** |
| 服务器地址 | `http://127.0.0.1:18445/` |
| 服务访问令牌 | 服务器 `.env` 中的 `SWITCH_SYNC_TOKEN` |
| 共享加密口令 | 各台电脑使用相同的至少 12 字符口令 |

这条方案需要维护 SSH 隧道。希望电脑联网后直接同步、不保留隧道终端，使用下面的 HTTPS 方案；easy-switch 当前不会自动创建 SSH 隧道。

### 3.3 方案 B：使用域名和 HTTPS

1. 将 `sync.example.com` 的 DNS A/AAAA 记录指向服务器。只保留服务器实际可达的记录。
2. 在服务器防火墙和云平台安全组放行 TCP **80、443**。已有网站占用这两个端口时，请使用现有反向代理，勿启动第二个抢占端口的代理。
3. 在 `.env` 中把 `SYNC_DOMAIN` 改为真实域名，**不带 `https://`、端口或路径**。
4. 在 `docs/sync-server` 目录启动：

```bash
docker compose --profile https up -d --build
docker compose ps
docker compose logs --tail=50 caddy
```

随附的 Caddy 配置会申请/续期证书并转发所有同步请求。自动 HTTPS 需要域名解析和端口可达，具体条件见 [Caddy 官方说明](https://caddyserver.com/docs/automatic-https)。

客户端填写：

| 字段 | 值 |
| --- | --- |
| 存储类型 | **自建服务器** |
| 服务器地址 | `https://sync.example.com/`，替换为真实域名 |
| 服务访问令牌 | `.env` 中的 `SWITCH_SYNC_TOKEN` |
| 共享加密口令 | 各台电脑使用相同口令 |

不要填写 `https://sync.example.com/sync.sqlite` 或 `http://服务器IP:18445/`。客户端接受 HTTPS，以及回环地址上的 HTTP；普通远程 HTTP 会被拒绝。

如果已有 Nginx，可把以下 `location` 放到**已配置有效证书的专用 HTTPS server 块**内：

```nginx
location / {
    client_max_body_size 256m;
    proxy_pass http://127.0.0.1:18445;
    proxy_http_version 1.1;
    proxy_request_buffering off;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
}
```

配置项的含义见 [Nginx 官方反向代理文档](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)。此时只启动 `docker compose up -d --build sync`。不要过滤 WebDAV 方法、移除 Authorization/ETag/条件请求头，也不要在同步域名前放浏览器交互式认证。服务器根路径直接在浏览器打开可能返回 401 或 404；这不等于部署失败，以 easy-switch 的“验证并保存”为准。

### 不使用 Docker：Node.js + systemd

需要 Node.js **22.13+**，普通客户端仍支持 Node.js 20.18.1。先确认 `node --version` 和 `command -v node`，然后准备目录：

```bash
git clone https://github.com/JasperRoc/easy-switch.git "$HOME/easy-switch-sync"
mkdir -p "$HOME/.config/easy-switch-sync" "$HOME/.local/share/easy-switch-sync" "$HOME/.config/systemd/user"
chmod 700 "$HOME/.config/easy-switch-sync" "$HOME/.local/share/easy-switch-sync"
openssl rand -hex 32
```

在 `~/.config/easy-switch-sync/server.env` 写入下列内容，替换令牌和**绝对路径**，并执行 `chmod 600 ~/.config/easy-switch-sync/server.env`：

```dotenv
SWITCH_SYNC_TOKEN=你的随机令牌
SWITCH_SYNC_DATABASE=/home/alice/.local/share/easy-switch-sync/sync.sqlite
SWITCH_SYNC_HOST=127.0.0.1
SWITCH_SYNC_PORT=18445
```

创建 `~/.config/systemd/user/easy-switch-sync.service`。`ExecStart` 的 Node 路径用 `command -v node` 的结果，项目路径替换为真实位置：

```ini
[Unit]
Description=easy-switch encrypted task sync
After=network.target

[Service]
ExecStart=/usr/bin/node /home/alice/easy-switch-sync/src/sync-server.js
EnvironmentFile=%h/.config/easy-switch-sync/server.env
Restart=on-failure
RestartSec=3
UMask=0077

[Install]
WantedBy=default.target
```

同步服务只使用 Node 内置模块，无需安装桌面工具或执行 `./install.sh`。启动服务：

```bash
systemctl --user daemon-reload
systemctl --user enable --now easy-switch-sync.service
journalctl --user -u easy-switch-sync.service -n 50 --no-pager
```

开机后及退出 SSH 后仍要运行时，启用当前用户的 linger；若无权限，由管理员执行 `sudo loginctl enable-linger 用户名`。之后按上文建立 SSH 隧道，或让你已有的 HTTPS 反向代理转发到 `127.0.0.1:18445`。

### 更新、备份和停止服务

Docker 部署在仓库中 `git pull --ff-only`，回到 `docs/sync-server` 执行最初的 `docker compose ... up -d --build` 命令。Node 部署拉取代码后运行 `systemctl --user restart easy-switch-sync.service`。

Docker 数据位于 `sync_data` 命名卷中。`docker compose down` 保留它；**`docker compose down -v` 会删除数据库和同步数据**。最简单的停机备份方式：

```bash
mkdir -p backups
docker compose stop sync
docker compose cp sync:/data/. ./backups/
docker compose start sync
```

将备份移到其他安全存储，避免在同一目录反复覆盖唯一备份。Node 部署也可以先停止服务，再复制数据库及可能存在的 `-wal`、`-shm` 文件，随后重启。服务在线时应使用 SQLite 备份接口，不要只复制主文件。恢复时停止服务，用备份恢复整个数据目录并保留容器 `node` 用户的写权限。

访问令牌和**共享加密口令**应另行保存；只有加密数据库而丢失口令，无法恢复会话内容。

## 4. 第二台电脑如何接收并继续任务

1. 安装并启动 easy-switch，在本机配置可用的 Codex 账号/API；凭据不会从第一台电脑复制。
2. 打开**设置 → 任务同步 → 存储配置**，填写同一存储地址、凭据和共享加密口令，点击**验证并保存**。
3. “同步任务”会自动出现远端已选择的会话。点击对应任务的**选择项目位置**，为这个 Git 项目选择一次本地目录。
4. 推荐使用空目录，例如 Mac 的 `~/Projects/my-app` 或 Windows 的 `D:\Projects\my-app`。已有目录必须是仓库根目录且与同步状态一致；有分叉改动时会停止，避免覆盖。
5. 等待显示“已同步”，在 Codex 打开对应项目并选择同一个会话继续。客户端可能需要刷新任务列表；未在侧栏显示时可先进入所选项目目录。

项目采用同步提交的 detached HEAD，暂存状态和未提交改动保留，不会覆盖本机其他分支。目标机器仍需自行准备 Git、运行依赖和外部工具。不要在两台电脑同时修改同一会话；若发生冲突，可以在任务行选择“采用本机版本”或“采用服务端版本”，确认前核对要保留的内容。

**自动同步的边界：**通常每 30 秒检查一次，软件隐藏到托盘后继续，睡眠或离线时暂停/退避。传输已完成的轮次，不迁移正在运行的进程。目标会话或共享项目仍被 Codex 占用时会等待释放，可能需要关闭并重新打开该会话。当前不保证已经打开的窗口实时刷新。

## 5. Linux 命令行配置

`switch sync` 配置的是当前电脑的客户端；它与上文存储服务器是两个角色。已安装的 easy-switch 当前用户服务负责后台同步：

```bash
switch sync setup           # 交互输入 WebDAV/自建地址、凭据、共享口令
switch sync list            # 查看任务 ID、状态和 project=<key>
switch sync add <task-id>   # 选择本机任务，开始上传
switch sync project <project-key> /absolute/local/project
switch sync now            # 可选，立即检查一次
switch sync remove <task-id>
switch sync resolve <task-id> local   # 或 remote，处理冲突
```

`setup` 后会重启当前用户的 easy-switch 服务；后续无需反复执行 `now`。移除选择只停止本机同步，不删除本地会话和远端副本；其他电脑可以分别取消选择。

## 6. 根据现象排查

| 现象 | 检查与处理 |
| --- | --- |
| HTTP 401 / 403 | WebDAV 应用密码或服务令牌；目录权限；代理是否丢弃 Authorization。自建服务用令牌，不用 SSH 密码 |
| HTTP 404 / 405 或目录不可用 | 是否填了完整协议地址，父目录是否存在，是否误用了分享链接；反向代理是否允许 WebDAV 方法 |
| 不支持 ETag / 条件写入 | 当前服务不能满足并发保护要求；更换正确支持的 WebDAV 或本项目自建服务 |
| 无法解密 | 两台电脑的共享加密口令不一致。修改存储密码不会自动修改加密口令 |
| 无法连接 | SSH 隧道是否仍在；DNS/证书/防火墙；easy-switch 是否沿用了无法连接该地址的外网代理 |
| HTTP 413 / 大小超限 | 代理请求体限制或任务包过大，当前加密包上限 256 MiB |
| 等待 Codex 释放会话 | 目标电脑仍加载旧会话。结束该轮并释放/关闭会话后等待同步，再打开 |
| 项目冲突 | 本地 Git 内容与上次同步状态不同。保留重要改动，再选择采用哪份版本 |
| 任务没有出现在 Codex 侧栏 | 确认使用相同本机用户和 `CODEX_HOME`、打开映射后的项目、刷新任务列表。云端专属任务不包含在内 |

当前要求已有提交且无 submodule 的 Git 项目。上限：Git bundle 128 MiB、会话日志 128 MiB、单个附件/未跟踪文件 32 MiB、加密包 256 MiB。Git 忽略文件、依赖、账号配置、完整运行环境、Git LFS 对象、自动运行目标及子代理任务树不在完整迁移范围；已提交到 Git 的敏感内容仍会随仓库历史同步。

任务在上传前使用 AES-256-GCM 加密，密钥由共享口令通过 scrypt 派生；服务器仍能看到任务标识、包大小及访问时间。本机共享口令与连接凭据保存在 easy-switch 私有配置目录。替换前的会话保留在 `CODEX_HOME/sync-backups`，项目及冲突恢复副本位于 easy-switch 同步缓存；彻底卸载会删除缓存内副本，重要数据请独立备份。

验证范围：本项目 WebDAV 协议测试、自建 SQLite 服务、两份隔离 Codex 环境的会话往返和桌面集成测试。未对所有商业 WebDAV 服务、你的公网域名或服务器环境逐一实测。
