# Desktop guide / 桌面版指南

[English README](../README.md) · [简体中文 README](README.zh-CN.md)

## Install

Download an installer from [GitHub Releases](https://github.com/JasperRoc/easy-switch/releases). Windows 10/11 x64 uses the `.exe` installer. macOS 13+ uses the `.dmg` matching Apple silicon (`arm64`) or Intel (`x64`); drag easy-switch to Applications and launch it. A zip distribution is also provided for macOS.

Node.js, Electron and a pinned official Codex executable are bundled. No terminal, npm installation or Linux service setup is needed. Install your normal Codex conversation client separately. The bundled Codex executable handles official device authentication and reads the model catalog; easy-switch itself is a routing/settings application.

The current packages have no publisher certificate; macOS packages are not notarized. Windows SmartScreen or macOS Gatekeeper may request first-launch approval. Obtain packages only from the project's releases and compare their SHA-256 sums with `SHA256SUMS.txt`. macOS first-launch approval is in System Settings → Privacy & Security when the system offers it. A managed device can prohibit unsigned software; these builds do not bypass organization policy.

Apple silicon macOS packaged-app tests cover adding an API, model discovery, model/effort selection, routing start/stop, window hiding, normal exit and forced-process-exit recovery. Intel macOS and Windows packages are built, but have not been run on those systems. This release is experimental.

## Everyday use

- **Add provider**: sign in with ChatGPT through the official device authentication page, import an existing file-based Codex sign-in, or enter an API key. A blank Base URL selects `https://api.openai.com/v1`. Third-party APIs must support Responses, SSE and Codex tool calls.
- **Tray/menu bar**: right-click the icon and select an alias. On Windows, double-click opens settings. Use “Providers & settings…” on either platform to open the window.
- **Priority**: use the up/down buttons next to providers. Changes do not change the currently selected alias. Eligible quota/authentication failures use this order, subject to the same cooldown and retry rules as the CLI.
- **Model & effort**: refresh the catalog, select both values, then apply. “Follow Codex” removes overrides. Changes apply globally to the next model request, including a tool continuation in the same task. Existing streams finish with their original selection. Native Codex model labels and capabilities are not changed.
- **Network**: enter an optional HTTP/HTTPS proxy and bypass hosts. The app does not automatically import OS proxy/PAC settings. Localhost always bypasses the outbound proxy. Saving network settings restarts routing and interrupts active requests. A SOCKS-only port is not supported; use your proxy application's HTTP or mixed port.
- **Start at login**: opt in using the checkbox or tray menu. It is off by default. OS login-item permissions may need approval. Turning it off does not stop an app that is already running.

Provider, priority and model settings are shared with `switch` when both use the same `SWITCH_HOME`. The desktop installer does not register a global terminal `switch` command. Existing Linux installations continue to use their CLI and systemd service independently.

## Routing lifetime and recovery

Installation does not change Codex configuration. Launching the app starts a loopback proxy on `127.0.0.1:18345`, records the original `CODEX_HOME/config.toml`, and enables the `easy_switch` provider. The default Codex directory is `~/.codex` (Windows: `%USERPROFILE%\.codex`). Environment overrides `CODEX_HOME` and `SWITCH_HOME` are supported when launching from a shell.

Restart Codex or reload its editor window after the first activation. Switching providers, priority or model while routing remains active needs no client restart. Configuration on a remote SSH server is separate: a desktop application cannot automatically route a remote extension's traffic through the desktop's localhost. Keep using the Linux installation on that server.

Closing the settings window hides it and leaves the tray application running. **Stop routing** and **Quit easy-switch** restore the previous connection settings. Quitting with active requests asks for confirmation because it interrupts those requests. Clients that cache the proxy endpoint need a restart/reload after routing stops; restoring a file cannot update a running client's cached configuration.

A separate recovery helper restores configuration if the main process crashes or is killed. Following a power loss, an unfinished recovery record is processed on the next launch. Restoration preserves unrelated model/settings edits made during the session. If the managed `easy_switch` provider itself was edited, restoration stops and retains the backup instead of overwriting user changes; normal quitting is cancelled so the proxy remains available. The recovery record is `desktop-session.json` in the data directory. Do not share it: configuration backups can contain credentials. If recovery is blocked, merge its `original` configuration with your current file, remove the easy-switch connection settings, and only then remove the recovery record.

If a Linux CLI service installation or another process already owns the configuration/port, desktop activation stops and shows an error. Do not run two managers against the same Codex directory.

## Data and updates

Data is stored in `~/.codex-switch` (`%USERPROFILE%\.codex-switch` on Windows), or `SWITCH_HOME`:

| Path | Purpose |
| --- | --- |
| `state.json` | Provider credentials, active selection, fallback order, model overrides and local proxy token |
| `accounts/<alias>/auth.json` | File-based ChatGPT credentials |
| `network.json` | Saved outbound proxy settings, which can contain proxy credentials |
| `desktop-session.json` | Temporary configuration backup while routing is active |
| `desktop.json` | Desktop preferences |
| `desktop-ui/` | Electron window/profile data |

Credentials remain local plaintext. Unix directory/file permissions or a Windows ACL restrict access; this is not encryption or OS keychain storage. The renderer receives provider metadata, not API keys or ChatGPT tokens. Authentication codes appear only in the sign-in UI and the corresponding request's authentication prompt.

Use **Downloads & updates** to open Releases. Quit the old application, install the new package and launch it. Saved providers and preferences are retained. The desktop application does not silently download or install updates; `switch update` remains the Linux CLI updater. To uninstall, turn off Start at login, quit the app to restore configuration, then use Windows Installed apps or move the macOS application to Trash. Data is retained; remove the data directory yourself if you also want to delete saved credentials.

## 简体中文

- 安装：Windows 下载 x64 `.exe`；macOS 13+ 根据 Apple 芯片或 Intel 下载对应 `.dmg`，拖入 Applications 后启动。无需安装 Node.js，也无需运行 `install.sh`；会话仍使用你自己的 Codex 客户端。
- 首次使用：点击 **Add provider** 添加订阅账号或 API，Base URL 留空使用官方 API；首次启用代理后重启 Codex 或重载编辑器窗口。
- 日常切换：右键托盘或菜单栏图标选择服务商；设置窗口可调整备用顺序、模型与 effort。修改在下一次模型请求生效，包括任务中的工具调用续接；已经开始的流不会中途迁移。
- 运行周期：仅安装不会接管配置；启动软件后接管，关闭窗口继续留在托盘，**Stop routing / Quit easy-switch** 恢复原连接设置。开机自启动默认关闭，可勾选 **Start at login**。原生客户端缓存了地址时，停止代理后可能需要重启客户端。
- 异常恢复：主进程崩溃后由独立助手恢复；断电等情况在下次启动时恢复。保留用户新增的普通设置；托管 provider 被修改时会保留备份并提示冲突，正常退出会取消。`desktop-session.json` 可能包含凭据，请勿公开。
- 网络：不会自动读取操作系统代理/PAC，可在 **Network** 填写 HTTP/HTTPS 代理地址，始终绕过 localhost。保存网络设置会重启代理并中断当前请求。远程服务器上的 Codex 仍需在服务器安装 Linux 版，桌面版无法直接接管 SSH 远端。
- 更新：点击 **Downloads & updates**，退出旧软件后安装新版本；账号与设置保留。`switch update` 是 Linux CLI 的更新方式。卸载前先关闭自启动并退出软件；默认保留本地账号数据，需要时可自行删除。
- 发布状态：尚未签名/公证，首次运行可能需要系统允许；不支持绕过企业设备策略。Apple 芯片 macOS 已完成打包程序测试，Windows 和 Intel macOS 目前仅完成构建，仍需对应系统实际验证。
