# Task sync

Task sync synchronizes selected **Codex** conversations between computers. It includes the saved conversation ID/history, model settings recorded in that history, local file attachments, Git commits and staged/unstaged/untracked changes. Each computer keeps its own Codex sign-in and easy-switch providers. Claude conversation sync is not included.

## Desktop setup

1. Open **Settings → Task sync → Configure & select tasks**.
2. Choose **WebDAV** or **Self-hosted server / SQLite**, enter the server URL and credentials, and set a shared encryption passphrase of at least 12 characters. Every device uses the same storage and passphrase. Click **Verify & save**.
3. Select the tasks to sync. Unselected local conversations are not uploaded.
4. Configure the other computer with the same storage. Selected remote tasks appear automatically; choose the local project folder once for each project. An empty folder is suitable. A folder already containing the exact project state can also be used. Unrelated or divergent local work is never intentionally overwritten.
5. Open the synchronized project in Codex and continue the existing task. Later updates run automatically while easy-switch is running, including while its window is hidden. Initial configuration, task selection and one project-location mapping per computer are required; subsequent transfers need no export/import action.

The task list uses Codex's saved titles. The Codex client may need to refresh its project/task list to display newly imported tasks. An already loaded conversation can retain an in-memory snapshot; sync respects Codex's writer lock and waits for that conversation to be released before replacing its saved history. Close/release that conversation on the destination, then reopen it after sync. This release does not control arbitrary already-running Codex app processes or guarantee live refresh of their open views. The previous imported local history is retained in `CODEX_HOME/sync-backups` before replacement; it is separate from easy-switch's credentials and survives uninstall. When shared project files need to change, other loaded Codex tasks in that directory also block the update, so their active work is not replaced underneath them.

## WebDAV

Create a dedicated `easy-switch/` directory in your WebDAV storage and enter its complete HTTPS URL. Use the WebDAV app password where required. Verification tests authenticated reading/writing, ETags and conditional requests. A WebDAV server that ignores `If-Match` / `If-None-Match` is rejected because it could silently overwrite concurrent work. Parent directories must already exist.

This implementation uses PROPFIND, MKCOL, GET, conditional PUT and DELETE for temporary verification files. It does not use or depend on a Zotero account. Real commercial WebDAV providers have not all been validated.

## Self-hosted server and database

The optional server stores encrypted task packages and revision pointers in SQLite. It requires Node.js **22.13 or later**; ordinary easy-switch clients keep their existing Node requirement. The client never connects directly to a public database port.

```bash
git clone https://github.com/JasperRoc/easy-switch.git
cd easy-switch
npm ci --omit=dev
export SWITCH_SYNC_TOKEN="$(openssl rand -hex 32)"
export SWITCH_SYNC_DATABASE="$PWD/data/sync.sqlite"
node src/sync-server.js
```

The default listener is `127.0.0.1:18445`. Set `SWITCH_SYNC_PORT` to change the port. Put a TLS reverse proxy in front of it and configure the desktop with the HTTPS URL and the same access token. A reverse proxy must permit 256 MiB requests, preserve ETag and conditional headers, and forward WebDAV methods.

Example systemd service, with a dedicated unprivileged user and an environment file readable only by that user:

```ini
[Unit]
Description=easy-switch task sync
After=network.target

[Service]
User=easy-switch-sync
WorkingDirectory=/opt/easy-switch
EnvironmentFile=/etc/easy-switch-sync.env
ExecStart=/usr/bin/node /opt/easy-switch/src/sync-server.js
Restart=on-failure
UMask=0077

[Install]
WantedBy=multi-user.target
```

The environment file contains `SWITCH_SYNC_TOKEN` and `SWITCH_SYNC_DATABASE`. Back up the SQLite database with a SQLite-aware backup method. Clients encrypt titles, history, attachments and project contents using AES-256-GCM with a key derived by scrypt from the shared passphrase. The server can observe opaque IDs, package sizes and access timing. Losing the passphrase loses access to the encrypted library. Local sync settings retain credentials in the private easy-switch data directory and are not copied to the other computer.

## Linux CLI

```bash
switch sync setup
switch sync list
switch sync add <task-id>
switch sync project <project-key> /absolute/local/project
switch sync now
switch sync remove <task-id>
switch sync resolve <task-id> local   # or remote
```

The existing easy-switch user service performs automatic sync. `setup` restarts it to load the initial settings; later task selections and path mappings are reloaded automatically. Removing a selection stops this computer from synchronizing that task; it does not delete the local Codex task or the remote copy. Configure and select separately on each device when you want to exclude an existing remote task.

## Continuation and conflicts

Synchronization transfers completed turns, not a live process or an open terminal. While a task has an unfinished turn it is marked as running and is not overwritten or published. A sleeping or offline source cannot upload new work. The normal check interval is 30 seconds; network failures back off. Sleep pauses timers and pending network operations. No task enumeration or sync helper runs while sync is unconfigured.

Every published revision uses a conditional write. If both devices changed a task after their last common revision, both copies are retained and the task shows a conflict. This version does not automatically merge tool histories or divergent project changes. Finish on one device at a time. For a conflict, choose **Use this computer** or **Use server version** in the task row, or use `switch sync resolve <task-id> local|remote`. Review the choice before confirming. The remote revision is retained as an encrypted conflict backup in the private sync cache; incoming replacement also retains the old local rollout in `CODEX_HOME/sync-backups` and the prior project snapshot in the sync cache. Cache backups are removed when easy-switch is completely uninstalled; they are not a substitute for independent backups.

Git restore validates the incoming bundle and patches in a temporary checkout before changing local files. A nonempty mapping must point to the repository root, not a nested folder. Git restore uses a detached HEAD at the synchronized commit so it cannot overwrite an unrelated local branch. Staging state and untracked files are restored; ignored files, installed dependencies, SSH keys, provider login files and arbitrary external runtime state are not copied. Files and project context mentioned in a conversation can contain sensitive content; selecting a task authorizes uploading its conversation and associated Git history. A tracked secret is still part of Git history. External absolute paths in historical tool arguments can remain machine-specific.

Current limits: a committed Git repository without submodules; Git installed on each machine; 128 MiB Git bundle, 128 MiB task history, 32 MiB per local attachment/untracked file, and 256 MiB encrypted package. Large histories, submodules, Git LFS objects, ignored dependencies, automatically resumed goals, subagent task trees and cloud-only Codex sessions are not supported as complete portable execution environments. Codex may still require compatible tools, models and providers on the destination.

## 简体中文

在“设置 → 任务同步 → 配置并选择任务”中填写 WebDAV 或自建同步服务地址、凭据及共享加密口令，然后勾选需要同步的 Codex 任务。另一台电脑填写同一配置，首次选择本地项目位置，后续由软件自动同步会话、Git 提交状态、暂存/未暂存改动、未跟踪文件和本地附件。会话 ID 保留，登录凭据和服务商配置各自独立。当前仅支持 Codex。

自建后端已提供，使用 Node.js 22.13+ 和 SQLite 保存加密数据，启动方式见上文；通过 HTTPS 反向代理访问。普通客户端不需要安装数据库。WebDAV 服务器必须支持 ETag 及条件写入；商业 WebDAV 服务尚未逐一实测。

每轮结束后同步，不迁移运行中的进程或终端。正常每 30 秒检查一次；睡眠时暂停，失败后降低频率。首次需要配置、勾选任务和选择项目位置；无需反复导出导入。Codex 可能需要刷新任务列表，已打开的会话可能缓存旧历史，收到新版本后需关闭再打开该会话。本版尚不能保证任意已运行 Codex 窗口实时更新。

两台电脑同时离线修改同一任务会保留冲突，不静默覆盖。可在任务行选择“采用本机版本”或“采用服务端版本”，也可运行 `switch sync resolve <task-id> local|remote`；替换前保留会话和项目恢复副本。卸载会删除 easy-switch 缓存内的恢复副本，应另行保留重要备份。还原采用 detached HEAD，保留暂存状态；忽略文件、依赖、账号凭据不复制，但已经提交进 Git 的敏感文件仍属于仓库历史。当前要求已有提交且无 submodule 的 Git 项目，并需目标机器具备兼容的模型、工具和项目依赖。完整运行环境、自动恢复目标任务、子代理任务树、Git LFS 数据及云端专属任务不在本版支持范围。
