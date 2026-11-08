# Desktop guide / 桌面版指南

[English README](../README.md) · [简体中文 README](README.zh-CN.md)

## Codex and Claude Code

The top client selector and tray menu manage independent provider lists for Codex and Claude Code. Adding a provider in one list does not add or switch the other. Both routes share the application lifetime; quitting restores both configurations. Each provider row has a pencil action to edit its alias and, for APIs, its Base URL/key. A blank replacement key keeps the original; existing keys never enter the renderer. Updating an endpoint or key invalidates its cached model selection.

Claude API and subscription setup, protocol requirements and first-release limits are documented in the [Claude Code guide](claude-code.md). Claude Code must be installed separately for official subscription login. Codex’s bundled sign-in helper and existing quota/image features are unchanged.

顶部客户端选择器与托盘菜单分别管理 Codex 和 Claude Code 的服务商，互不切换；两个路由均随软件退出恢复。点击条目的铅笔图标可编辑别名及 API 地址、密钥，密钥留空保留；原密钥不传入界面。更改地址或密钥会清除旧模型选择。Claude 的 API、订阅认证与首批适配限制见 [Claude Code 指南](claude-code.md)。

## Install

Download an installer from [GitHub Releases](https://github.com/JasperRoc/easy-switch/releases). Windows 10/11 x64 uses the `.exe` installer. macOS 13+ uses the `.dmg` matching Apple silicon (`arm64`) or Intel (`x64`); drag easy-switch to Applications and launch it. A zip distribution is also provided for macOS.

Node.js, Electron and a pinned official Codex executable are bundled. No terminal, npm installation or Linux service setup is needed. Install your normal Codex conversation client separately. The bundled Codex executable handles official device authentication and reads the model catalog; easy-switch itself is a routing/settings application.

The current packages have no publisher certificate; macOS uses ad hoc code signing for bundle integrity and is not notarized. Windows SmartScreen or macOS Gatekeeper may request first-launch approval. Obtain packages only from the project's releases and compare their SHA-256 sums with `SHA256SUMS.txt`. For macOS first-launch approval and the previous damaged-app alert, follow the instructions below. A managed device can prohibit unsigned software; these builds do not bypass organization policy.

Apple silicon macOS packaged-app tests cover adding an API, model discovery, model/effort selection, routing start/stop, window hiding, normal exit and forced-process-exit recovery. Intel macOS and Windows packages are built, but have not been run on those systems. This release is experimental.

## Desktop preferences access errors

An `EPERM`, `EACCES` or `EBUSY` error opening `desktop.json` concerns local desktop preferences, not an upstream model or subscription. Versions 0.5.0–0.5.1 exit if that read fails. From 0.5.2, the app opens with defaults or the last preferences read during the current run, displays a notice, and preserves the inaccessible file. Saving desktop preferences remains blocked until the file can be read again. Provider and account files are handled separately; their errors are not silently ignored. The error alone does not establish whether a Windows ACL, file lock or security application caused it. From 0.5.3, Windows grants current-user access before disabling inheritance on the data root, without recursively disabling child inheritance. If reading desktop preferences still fails, a single bounded repair may add current-user access only to that user-owned, regular `desktop.json`, with no explicit deny rules. It never takes ownership, removes denies, changes provider credentials or grants other users access; a lock or security-product block is not cleared by ACL repair. Error dialogs include the app version.

If an older version cannot open, download the current installer manually from Releases. To reset only desktop preferences, fully quit easy-switch, then back up the preference file in a normal PowerShell window:

```powershell
$p = Join-Path $env:USERPROFILE '.codex-switch\desktop.json'
Rename-Item -LiteralPath $p -NewName ("desktop.json.bak-" + (Get-Date -Format yyyyMMddHHmmss))
```

Launch the app again. This preserves the old file as a backup and leaves provider credentials in place. If renaming also fails, inspect the file's access permissions and locks before changing them; do not delete the data directory.

中文版：`desktop.json` 保存语言、外观等桌面偏好。0.5.0–0.5.1 遇到该文件不可读时会退出；0.5.2 起保留原文件、显示提示，并使用默认设置或本次运行已读取的设置继续打开，恢复访问后可重新保存。服务商和账号文件单独处理，不会忽略它们的读取错误。报错本身不能证明是权限、文件占用还是安全软件造成的。0.5.3 起先授予当前用户根目录访问权，再关闭根目录继承，不再递归禁用子文件继承；偏好仍不可读时，只尝试修复当前用户拥有、没有显式拒绝规则的普通 desktop.json，一次尝试且有时限，不接管所有权、不删除拒绝规则、不修改服务商凭据。文件占用和安全软件阻止不能靠授予权限解除。错误弹窗会显示软件版本。旧版打不开时可手动下载安装包；也可完全退出后执行上面的 PowerShell 命令，仅将偏好文件重命名为备份，再重新打开。该操作保留服务商和凭据；若重命名同样失败，应先检查权限和占用，不要删除整个数据目录。

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
- **Tray/menu bar**: the window/taskbar and macOS Dock explicitly use the application’s ocean icon; the Windows taskbar uses the same application identity as installer shortcuts. Single-click the icon to reopen settings, including after closing or minimizing the window. Right-click opens the provider menu; Windows also supports double-click to open settings. Use “Providers & settings…” on either platform to open the window.
- **Priority**: hold the six-dot grip on the left of a provider and drag it. Keyboard users can focus the grip and use ↑/↓. The trash button removes the provider; deleting an account removes only the credential copy owned by easy-switch, while deleting an API removes its saved key. The active provider changes to the next ordered provider. Changes do not change the currently selected alias. Eligible quota/authentication failures use this order, subject to the same cooldown and retry rules as the CLI.
- **Subscription quota**: Plus uses one ring: the smaller upper arc shows 5-hour remaining quota and the larger lower arc shows weekly quota; Pro uses a full weekly ring. Hover an arc to lift it and reveal its remaining percentage and reset time. The compact ring uses neutral arcs and a center diamond. Hover or focus the center diamond to see purchased credits, independently of time-window quota, including before weekly exhaustion. There is no separate balance block. Quota refreshes at most once per minute per account while the window is visible. Hiding or minimizing aborts automatic quota reads and their credential-refresh helpers; failed reads use increasing retry delays, capped at 15 minutes. Clicking does not expand details. Polling uses the configured outbound proxy, and does not change the text provider or consume reset credits. Failed reads retain visibly marked last-known data; missing fields are never fabricated.
- **Quota reset cards**: use the reset icon on a subscription row to read earned reset cards through an isolated official Codex account session. Select an individual card after checking its expiration and confirm to consume it. Expired cards are disabled; missing dates/details are explicit. An uncertain request keeps the same card and idempotency key on retry, including after reopening the dialog. Successful/reset-already-applied outcomes trigger fresh card and quota reads; the selected provider, native login and purchased credits are not changed. No reset is automatic.
- **Background activity**: unchanged state does not repaint the UI or rebuild tray menus. Hidden/minimized windows use a 30-second tray maintenance pass without quota queries or renderer refreshes. Sleep and screen lock pause this maintenance; waking and unlocking refresh the visible window without replaying missed polls. The proxy continues serving requests while hidden or locked, and easy-switch does not request a system sleep-prevention assertion.
- **Provider model lookup**: click the magnifying glass on any row, including inactive providers, to query that provider only. Search the returned IDs or refresh; the dialog reports loading, count/read time, empty results or failure. Codex APIs use `/models`; subscriptions use an isolated official catalog process. Claude supports provider model-list endpoints. Listing a model does not establish inference/tool access. Choose the model and effort in the native client. No task list or session metadata polling is maintained.
- **Claude model mapping**: the API add/edit dialog has optional main/subagent model IDs. Claude-family requests are mapped only for that API; agent-tagged requests and Haiku requests use the subagent ID when configured. Tools and history are preserved. The main ID is also exposed as a custom model-menu entry for new Claude processes. See [Claude Code](claude-code.md) for display, fallback and compatibility limits.
- **Native images**: image generation and edit requests use available subscription accounts in priority order without changing the selected text provider or model. Adding a subscription configures native image tools. Existing file-based native subscription credentials are retained; API or keychain-only setups use a temporary file-based sign-in from an account added to easy-switch, with the original auth file and credential-store settings backed up and restored on stop, exit or recovery. Reload an already-open Codex client once to refresh its tool registry. Later provider switches keep the tool available. Codex’s native account label continues to show the subscription identity used to expose image tools; it does not reflect the selected text upstream. The provider-page notice identifies the selected text route separately. Text requests use the selected provider’s credentials and image requests use subscription quota.
- **Free image access**: Free accounts do not supply Codex image generation. Known Free image routes are skipped. If the original native login is Free, an added eligible paid account can temporarily supply its tool identity; the original Free login is restored on stop/exit/recovery. With no eligible account, a notice explains the client tool limitation. An API can handle an image request reaching the proxy, but cannot enable a tool already disabled by the Free client. Explicit upstream plan/model-access rejections can try another eligible image account before output.
- **Capacity recovery**: explicit model-capacity failures in HTTP or startup SSE are retried before any output is accepted. Available alternatives follow priority order; otherwise up to two delayed retries honor Retry-After, with waits limited to 30 seconds each. A longer requested delay is not shortened; the error is returned. Accepted output/tool events and ended turns are not replayed or restarted.
- **Connection settings**: the page separately displays the actual easy-switch local routing endpoint (default `http://127.0.0.1:18345/v1`) and the detected outbound Internet proxy. At startup, saved preferences take precedence over environment variables, then enabled macOS/Windows HTTP/HTTPS system proxies. Detected settings apply automatically when no preferences were saved. An external proxy may use a port such as `7890`; it belongs to Clash/V2Ray or another proxy application, not easy-switch. Saving a blank address selects direct access. Localhost always bypasses the outbound proxy. PAC scripts, automatic proxy discovery and SOCKS-only settings are not applied automatically; enter your proxy application’s HTTP or mixed address if needed. The proxy address is visible; optional proxy credentials and bypass rules are under Advanced settings. Bypass entries connect directly instead of using the outbound proxy; most users can keep the detected defaults. Saving network settings restarts routing and interrupts active requests. A SOCKS-only port is not supported; use your proxy application's HTTP or mixed port.
- **Language and appearance**: use the globe and appearance icons in the top-right; no large selector boxes. English/简体中文 and System/Light/Dark are saved.
- **Star**: the star button opens the GitHub repository without exposing credentials.
- **Start at login**: opt in using the checkbox or tray menu. It is off by default. OS login-item permissions may need approval. Turning it off does not stop an app that is already running.

Provider and priority settings are shared with `switch` when both use the same `SWITCH_HOME`. The desktop installer does not register a global terminal `switch` command. Existing Linux installations continue to use their CLI and systemd service independently.

## Routing lifetime and recovery

Installation does not change Codex configuration. Launching the app starts a loopback proxy on `127.0.0.1:18345`, records the original `CODEX_HOME/config.toml`, and enables the `easy_switch` provider. The default Codex directory is `~/.codex` (Windows: `%USERPROFILE%\.codex`). Environment overrides `CODEX_HOME` and `SWITCH_HOME` are supported when launching from a shell.

Restart Codex or reload its editor window after the first activation. Switching providers or priority while routing remains active needs no client restart. Native model-menu entries are loaded when the client starts. Configuration on a remote SSH server is separate: a desktop application cannot automatically route a remote extension's traffic through the desktop's localhost. Keep using the Linux installation on that server.

Closing the settings window hides it and leaves the tray application running. **Stop routing** and **Quit easy-switch** restore the previous connection settings. Quitting with active requests asks for confirmation because it interrupts those requests. Clients that cache the proxy endpoint need a restart/reload after routing stops; restoring a file cannot update a running client's cached configuration.

A separate recovery helper restores configuration if the main process crashes or is killed. Following a power loss, an unfinished recovery record is processed on the next launch. Restoration preserves unrelated model/settings edits made during the session. If the managed `easy_switch` provider itself was edited, restoration stops and retains the backup instead of overwriting user changes; normal quitting is cancelled so the proxy remains available. The recovery record is `desktop-session.json` in the data directory. Do not share it: configuration and temporary native-sign-in backups can contain credentials. If recovery is blocked, merge its `original` configuration with your current file, remove the easy-switch connection settings, and only then remove the recovery record.

If a Linux CLI service installation or another process already owns the configuration/port, desktop activation stops and shows an error. Do not run two managers against the same Codex directory.

## Data and updates

Data is stored in `~/.codex-switch` (`%USERPROFILE%\.codex-switch` on Windows), or `SWITCH_HOME`:

| Path | Purpose |
| --- | --- |
| `state.json` | Provider credentials, active selection, fallback order and local proxy token |
| `accounts/<alias>/auth.json` | File-based ChatGPT credentials |
| `network.json` | Saved outbound proxy settings, which can contain proxy credentials |
| `desktop-session.json` | Temporary configuration backup while routing is active |
| `desktop.json` | Language, appearance and desktop preferences |
| `desktop-ui/` | Electron window/profile data |

Credentials remain local plaintext. Unix directory/file permissions or a Windows ACL restrict access; this is not encryption or OS keychain storage. The renderer receives provider metadata, not API keys or ChatGPT tokens. Authentication codes appear only in the sign-in UI and the corresponding request's authentication prompt.

Use **Check for updates** to query the official GitHub release API. In automatic mode, update checks and downloads use the operating system’s network stack and proxy/PAC settings. Explicit saved/environment proxy preferences continue to take precedence. Failed downloads show a connection hint and a Retry download action; size and SHA-256 checks remain required. Older versions with a broken download path may require one manual installer download to upgrade. The update window displays structured release notes in the selected interface language. A release without that translation shows an explicit localized notice rather than silently substituting English. The latest-version view avoids install warnings and duplicate status text. The window shows the release notes first; no package is downloaded while checking. Choose **Download update**, then **Install & restart** after the package’s size, SHA-256 digest and (on macOS) application identity/signature have been verified. macOS installation stages the new app, launches it, waits for a startup receipt and rolls back if startup is not confirmed. Windows uses the per-user installer after the existing app exits. Active requests require explicit confirmation before installation. Providers and preferences are retained. `switch update` remains the Linux CLI updater. To uninstall, turn off Start at login, quit the app to restore configuration, then use Windows Installed apps or move the macOS application to Trash. Data is retained; remove the data directory yourself if you also want to delete saved credentials.

## 简体中文

- 安装：Windows 下载 x64 `.exe`；macOS 13+ 根据 Apple 芯片或 Intel 下载对应 `.dmg`，拖入 Applications 后启动。无需安装 Node.js，也无需运行 `install.sh`；会话仍使用你自己的 Codex 客户端。
- 首次使用：点击 **添加订阅**、**添加 API 服务商** 或 **导入当前 Codex 配置**，Base URL 留空使用官方 API；首次启用代理后重启 Codex 或重载编辑器窗口。
- 日常切换：单击托盘或菜单栏图标重新打开窗口，最小化窗口也会恢复；右键选择客户端及服务商，Windows 保留双击打开。按住左侧六点柄拖拽排序，使用铅笔编辑或删除条目。添加订阅、导入现有登录、添加 API 分开操作；验证码只在订阅弹窗中显示，认证结束后清除。每行放大镜查询该服务商自身目录，未选中条目也可查询，查询不改变路由；支持搜索及刷新结果反馈，不使用其他服务商目录替代。模型及推理强度在会话客户端内选择，不再列举任务或轮询会话元数据。Claude API 可在添加/编辑时填写主模型、子代理模型映射，详见 [Claude Code](claude-code.md)。
- 订阅额度：Plus 在同一个环内以上方小段弧线显示 5 小时剩余额度、下方大段弧线显示周剩余额度；Pro 显示周额度整环。悬停某段弧线会轻微浮起并显示对应剩余百分比和重置时间。额度圈采用中性灰色弧线与中心菱形；购买额度独立于时间窗口，悬停或聚焦中心菱形显示余额，不再设置独立余额块。窗口显示时每分钟读取一次；隐藏或最小化后取消自动查询及其凭据刷新进程，失败后逐步延长重试间隔，最长 15 分钟。点击不再展开详情；读取失败保留并标注上次结果，不估算余额。
- 重置卡：点击订阅条目的重置图标，查看按过期时间排列的卡片，选定后确认消耗；过期卡禁用，未返回的明细和有效期明确提示。结果不明时重试保持同一卡片和请求标识，关闭后重新打开也会保留本次尝试；完成后重新读取卡片及额度，不改变当前服务商、原生登录或购买额度，不会自动兑换。
- 图片生成：内置图片生成及编辑请求按优先级借用可用订阅，不改变文字服务商或模型，会消耗订阅额度。桌面版添加订阅后会启用原生图片工具设置。若 Codex 原先为 API 认证或仅使用钥匙串凭据，则临时接入已添加订阅的文件式登录，并备份原始登录及设置；停止路由、退出或崩溃恢复时还原。用户另外进行的原生登录会保留。首次接入后请重载已打开的 Codex，后续切换服务商仍保留工具。Codex 的账号标识仍显示用于启用图片工具的订阅身份，不代表文字请求的上游；界面会单独显示当前文字路由。文字请求使用所选服务商的凭据，图片请求使用订阅。
- 容量恢复：对 HTTP 或 SSE 启动阶段明确的模型容量不足，在接受输出前按队列尝试备用服务；无备用可用时最多延迟重试两次。遵守 Retry-After，每次最多等待 30 秒；上游要求更长等待时直接返回错误，不提前重试。已接受的输出、工具事件及已结束的任务不会重放或重启。
- 后台能耗：状态未变化时不重绘界面、不重建托盘菜单；隐藏或最小化后每 30 秒维护托盘状态，不查询额度、不刷新隐藏界面。休眠或锁屏时暂停维护，唤醒并解锁后刷新可见窗口，不补跑错过的轮询。隐藏或锁屏时仍可转发实际请求，软件不申请阻止系统休眠。
- 运行周期：仅安装不会接管配置；启动软件后接管，关闭窗口继续留在托盘，**Stop routing / Quit easy-switch** 恢复原连接设置。开机自启动默认关闭，可勾选 **Start at login**。原生客户端缓存了地址时，停止代理后可能需要重启客户端。
- 异常恢复：主进程崩溃后由独立助手恢复；断电等情况在下次启动时恢复。保留用户新增的普通设置；托管 provider 被修改时会保留备份并提示冲突，正常退出会取消。`desktop-session.json` 可能包含凭据，请勿公开。
- 连接设置：分别显示 easy-switch 本地路由地址（默认 `http://127.0.0.1:18345/v1`）和外网代理。启动时依次采用手动保存的设置、环境变量、macOS/Windows 系统 HTTP/HTTPS 代理；未保存过设置时自动应用检测结果。`7890` 一类端口通常属于 Clash/V2Ray 等外网代理，与 easy-switch 的本地端口不同。保存空地址可使用直连。代理地址直接显示；认证密码和不经过代理的地址规则收纳在“高级设置”中，多数用户保留自动读取的绕过规则即可。PAC、自动代理发现和纯 SOCKS 暂不支持自动应用，可手动填写 HTTP 或混合端口；本机地址始终直连。保存网络设置会重启代理并中断当前请求。远程服务器上的 Codex 仍需在服务器安装 Linux 版，桌面版无法直接接管 SSH 远端。
- 更新：自动模式使用操作系统网络栈及代理/PAC 设置，手动保存或环境变量中的设置仍优先。下载失败可直接重试；无法下载的旧版可能需要先手动下载安装包升级一次。更新详情随界面语言选择中英文说明；尚无对应翻译的旧版会明确提示。最新版界面不再重复状态或显示无关安装提示。点击 **Check for updates**，先查看版本说明；确认后下载并校验，再点击 **Install & restart**。macOS 启动失败会自动回滚，账号与设置保留。`switch update` 是 Linux CLI 的更新方式。卸载前先关闭自启动并退出软件；默认保留本地账号数据，需要时可自行删除。
- 语言外观：顶部使用地球与外观图标切换中英文及跟随系统/浅色/深色，立即生效并自动保存；托盘菜单及退出提示同步切换语言。点击 ⭐️ 可打开 GitHub 仓库。海洋蓝主题采用磨砂玻璃质感，并尊重系统减少动态效果设置。
- 发布状态：macOS 已采用临时签名验证完整性，但尚无 Developer ID/公证；Windows 尚无发布者签名，首次运行可能需要系统允许；不支持绕过企业设备策略。Apple 芯片 macOS 已完成打包程序测试，Windows 和 Intel macOS 目前仅完成构建，仍需对应系统实际验证。
