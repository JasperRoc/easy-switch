# Desktop guide / 桌面版指南

[English README](../README.md) · [简体中文 README](README.zh-CN.md)

## Install

Download an installer from [GitHub Releases](https://github.com/JasperRoc/easy-switch/releases). Windows 10/11 x64 uses the `.exe` installer. macOS 13+ uses the `.dmg` matching Apple silicon (`arm64`) or Intel (`x64`); drag easy-switch to Applications and launch it. A zip distribution is also provided for macOS.

Node.js, Electron and a pinned official Codex executable are bundled. No terminal, npm installation or Linux service setup is needed. Install your normal Codex conversation client separately. The bundled Codex executable handles official device authentication and reads the model catalog; easy-switch itself is a routing/settings application.

The current packages have no publisher certificate; macOS uses ad hoc code signing for bundle integrity and is not notarized. Windows SmartScreen or macOS Gatekeeper may request first-launch approval. Obtain packages only from the project's releases and compare their SHA-256 sums with `SHA256SUMS.txt`. For macOS first-launch approval and the previous damaged-app alert, follow the instructions below. A managed device can prohibit unsigned software; these builds do not bypass organization policy.

Apple silicon macOS packaged-app tests cover adding an API, model discovery, model/effort selection, routing start/stop, window hiding, normal exit and forced-process-exit recovery. Intel macOS and Windows packages are built, but have not been run on those systems. This release is experimental.

## macOS preview and the damaged-app alert

Version 0.3.0 skipped signing after modifying Electron’s application bundle, leaving invalid resource signatures. This could produce “easy-switch is damaged and can’t be opened.” Version 0.3.1 re-signs the app and its nested code, fails the build if strict signature validation fails, and verifies the final DMG’s mounted application before release. Replace the old application with a fresh 0.3.1 or later download.

An ad hoc signature verifies integrity; it does **not** establish an Apple-trusted publisher identity or replace notarization. Gatekeeper can still block these preview downloads. First compare the installer with `SHA256SUMS.txt`, install it into Applications, and verify the copied app:

```bash
codesign --verify --deep --strict "/Applications/easy-switch.app"
```

A successful command exits without an error. Then use **System Settings → Privacy & Security → Open Anyway** if offered. If macOS does not offer approval for this ad hoc preview, after verifying that you trust this specific download, remove the quarantine attribute from this application only:

```bash
xattr -dr com.apple.quarantine "/Applications/easy-switch.app"
```

Launch easy-switch again. Adjust the path if installed elsewhere. This does not turn off system-wide Gatekeeper. A managed device may prevent this; organization policy is not bypassed. Do not use the command to hide a failed `codesign` check. For public distribution without this manual step, the publisher still needs an Apple Developer ID certificate and notarization credentials.

中文版：0.3.0 跳过了修改后的 Electron 应用重签名，造成资源签名失效。请下载 0.3.1 或更新版本，替换旧软件。新版采用临时签名验证完整性，但没有 Developer ID 和 Apple 公证，系统仍可能阻止首次打开。核对安装包 SHA-256 并通过上面的 `codesign` 检查后，可到「系统设置 → 隐私与安全性 → 仍要打开」允许；若没有入口，可对已确认可信的这一个应用执行上面的 `xattr` 命令，然后重新打开。无需关闭系统全局安全检查；签名检查失败时不要使用该命令掩盖错误。

## Everyday use

- **Language and appearance**: choose English or Simplified Chinese, and System, Light or Dark in the top toolbar. Changes apply immediately and persist across restarts. Tray menus and quit confirmations use the same language. System mode follows OS appearance changes. Ocean-blue glass surfaces use `RGB(0,63,136)` as the brand color, with restrained transitions that respect reduced-motion settings.
- **Add subscription**: choose an alias and complete official ChatGPT device authentication. The link and verification code remain inside this dialog and are cleared on success or failure; closing the dialog keeps pending authentication running, and choosing Add subscription reopens it. **Import current Codex setup** detects the provider configured before easy-switch activation and previews its type and address. It supports API keys in `auth.json`, `experimental_bearer_token`, Bearer authorization headers and available `env_key` environment variables, as well as file-based subscription credentials. Keys are not sent to the renderer. A Finder-launched app may not inherit terminal-only environment variables; use Add API provider if the key cannot be read. OS-keychain-only credentials and extra custom headers are not imported automatically. **Add API** is for official or third-party API keys. A blank Base URL selects `https://api.openai.com/v1`. Third-party APIs must support Responses, SSE and Codex tool calls.
- **Tray/menu bar**: right-click the icon and select an alias. On Windows, double-click opens settings. Use “Providers & settings…” on either platform to open the window.
- **Priority**: hold the six-dot grip on the left of a provider and drag it. Keyboard users can focus the grip and use ↑/↓. The trash button removes the provider; deleting an account removes only the credential copy owned by easy-switch, while deleting an API removes its saved key. The active provider changes to the next ordered provider. Changes do not change the currently selected alias. Eligible quota/authentication failures use this order, subject to the same cooldown and retry rules as the CLI.
- **Model & effort**: refresh the catalog, search by model name/ID, choose a reasoning-effort button, then apply. Refresh shows a loading indicator and then the number of models and read time, or an explicit failure. “Follow Codex” uses the client’s choice; “Provider default” lets the upstream choose reasoning effort. APIs list all model IDs returned by `/models`, including custom IDs. Known Codex metadata provides effort choices; unknown models use the provider default. Catalog membership does not prove Responses or tool-call compatibility. Subscription catalogs use the selected account in an isolated Codex process. “Follow Codex” removes overrides. Changes apply globally to the next model request, including a tool continuation in the same task. Existing streams finish with their original selection. Native Codex model labels and capabilities are not changed.
- **Connection settings**: the page separately displays the actual easy-switch local routing endpoint (default `http://127.0.0.1:18345/v1`) and the detected outbound Internet proxy. At startup, saved preferences take precedence over environment variables, then enabled macOS/Windows HTTP/HTTPS system proxies. Detected settings apply automatically when no preferences were saved. An external proxy may use a port such as `7890`; it belongs to Clash/V2Ray or another proxy application, not easy-switch. Saving a blank address selects direct access. Localhost always bypasses the outbound proxy. PAC scripts, automatic proxy discovery and SOCKS-only settings are not applied automatically; enter your proxy application’s HTTP or mixed address if needed. The proxy address is visible; optional proxy credentials and bypass rules are under Advanced settings. Bypass entries connect directly instead of using the outbound proxy; most users can keep the detected defaults. Saving network settings restarts routing and interrupts active requests. A SOCKS-only port is not supported; use your proxy application's HTTP or mixed port.
- **Language and appearance**: use the globe and appearance icons in the top-right; no large selector boxes. English/简体中文 and System/Light/Dark are saved.
- **Star**: the star button opens the GitHub repository without exposing credentials.
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
| `desktop.json` | Language, appearance and desktop preferences |
| `desktop-ui/` | Electron window/profile data |

Credentials remain local plaintext. Unix directory/file permissions or a Windows ACL restrict access; this is not encryption or OS keychain storage. The renderer receives provider metadata, not API keys or ChatGPT tokens. Authentication codes appear only in the sign-in UI and the corresponding request's authentication prompt.

Use **Check for updates** to query the official GitHub release API. In automatic mode, update checks and downloads use the operating system’s network stack and proxy/PAC settings. Explicit saved/environment proxy preferences continue to take precedence. Failed downloads show a connection hint and a Retry download action; size and SHA-256 checks remain required. Older versions with a broken download path may require one manual installer download to upgrade. The window shows the release notes first; no package is downloaded while checking. Choose **Download update**, then **Install & restart** after the package’s size, SHA-256 digest and (on macOS) application identity/signature have been verified. macOS installation stages the new app, launches it, waits for a startup receipt and rolls back if startup is not confirmed. Windows uses the per-user installer after the existing app exits. Active requests require explicit confirmation before installation. Providers and preferences are retained. `switch update` remains the Linux CLI updater. To uninstall, turn off Start at login, quit the app to restore configuration, then use Windows Installed apps or move the macOS application to Trash. Data is retained; remove the data directory yourself if you also want to delete saved credentials.

## 简体中文

- 安装：Windows 下载 x64 `.exe`；macOS 13+ 根据 Apple 芯片或 Intel 下载对应 `.dmg`，拖入 Applications 后启动。无需安装 Node.js，也无需运行 `install.sh`；会话仍使用你自己的 Codex 客户端。
- 首次使用：点击 **添加订阅**、**添加 API 服务商** 或 **导入当前 Codex 配置**，Base URL 留空使用官方 API；首次启用代理后重启 Codex 或重载编辑器窗口。
- 日常切换：右键托盘或菜单栏图标选择服务商；设置窗口可按住服务商左侧六点拖拽柄调整备用顺序，也可删除服务商。**添加订阅**、**导入当前 Codex 配置**、**添加 API** 分开操作。导入可自动识别原 Codex API 配置、可用环境变量密钥或文件式订阅凭据，确认类型和地址后保存；系统钥匙串中的凭据和额外自定义请求头暂不自动导入。验证码仅在添加订阅弹窗中显示，认证完成或失败后自动清除。模型界面提供搜索与推理强度按钮，刷新后显示模型数量和读取时间。API 模型目录保留服务商返回的全部 ID；未知模型使用默认推理强度，仍需确认 Responses 与工具调用兼容性。修改在下一次模型请求生效，包括任务中的工具调用续接；已经开始的流不会中途迁移。
- 运行周期：仅安装不会接管配置；启动软件后接管，关闭窗口继续留在托盘，**Stop routing / Quit easy-switch** 恢复原连接设置。开机自启动默认关闭，可勾选 **Start at login**。原生客户端缓存了地址时，停止代理后可能需要重启客户端。
- 异常恢复：主进程崩溃后由独立助手恢复；断电等情况在下次启动时恢复。保留用户新增的普通设置；托管 provider 被修改时会保留备份并提示冲突，正常退出会取消。`desktop-session.json` 可能包含凭据，请勿公开。
- 连接设置：分别显示 easy-switch 本地路由地址（默认 `http://127.0.0.1:18345/v1`）和外网代理。启动时依次采用手动保存的设置、环境变量、macOS/Windows 系统 HTTP/HTTPS 代理；未保存过设置时自动应用检测结果。`7890` 一类端口通常属于 Clash/V2Ray 等外网代理，与 easy-switch 的本地端口不同。保存空地址可使用直连。代理地址直接显示；认证密码和不经过代理的地址规则收纳在“高级设置”中，多数用户保留自动读取的绕过规则即可。PAC、自动代理发现和纯 SOCKS 暂不支持自动应用，可手动填写 HTTP 或混合端口；本机地址始终直连。保存网络设置会重启代理并中断当前请求。远程服务器上的 Codex 仍需在服务器安装 Linux 版，桌面版无法直接接管 SSH 远端。
- 更新：自动模式使用操作系统网络栈及代理/PAC 设置，手动保存或环境变量中的设置仍优先。下载失败可直接重试；无法下载的旧版可能需要先手动下载安装包升级一次。点击 **Check for updates**，先查看版本说明；确认后下载并校验，再点击 **Install & restart**。macOS 启动失败会自动回滚，账号与设置保留。`switch update` 是 Linux CLI 的更新方式。卸载前先关闭自启动并退出软件；默认保留本地账号数据，需要时可自行删除。
- 语言外观：顶部使用地球与外观图标切换中英文及跟随系统/浅色/深色，立即生效并自动保存；托盘菜单及退出提示同步切换语言。点击 ⭐️ 可打开 GitHub 仓库。海洋蓝主题采用磨砂玻璃质感，并尊重系统减少动态效果设置。
- 发布状态：macOS 已采用临时签名验证完整性，但尚无 Developer ID/公证；Windows 尚无发布者签名，首次运行可能需要系统允许；不支持绕过企业设备策略。Apple 芯片 macOS 已完成打包程序测试，Windows 和 Intel macOS 目前仅完成构建，仍需对应系统实际验证。
