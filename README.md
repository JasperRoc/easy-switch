**English** · [简体中文](docs/README.zh-CN.md)

# easy-switch: A better AI conversation experience

![Node.js](https://img.shields.io/badge/Node.js-22%2B-417E38?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-2563EB?style=flat-square)
![Status](https://img.shields.io/badge/Status-Experimental-D97706?style=flat-square)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](docs/LICENSE)

easy-switch is a desktop and command-line account and API routing tool for Codex, bringing **ChatGPT subscription accounts, the official OpenAI API, and third-party compatible APIs** into one workflow. It switches providers at model request boundaries while preserving the client process and conversation. Eligible quota or authentication rejections trigger retries through alternatives in the configured priority order.

🔄 **In-session switching** · 🖥️ **Tray and menu bar controls** · 🌊 **Ocean glass UI · EN / 中文 · Light / dark** · 🧠 **Model and effort selection** · ⚙️ **Automatic failover**

[Quick start](#quick-start) · [Why easy-switch?](#why-easy-switch) · [FAQ](#faq) · [Disclaimer](#disclaimer) · [Contributing](#contributing) · [License](#license)

<a id="quick-start"></a>

## 🚀 Quick start

### 🖥️ Windows and macOS

Download the matching installer from [GitHub Releases](https://github.com/JasperRoc/easy-switch/releases):

| System | Installer |
| --- | --- |
| Windows 10/11 x64 | `easy-switch-<version>-win-x64.exe` |
| macOS 13+ · Apple silicon | `easy-switch-<version>-mac-arm64.dmg` |
| macOS 13+ · Intel | `easy-switch-<version>-mac-x64.dmg` |

1. Install and launch **easy-switch**. Node.js and the official Codex sign-in helper are bundled.
2. Use **Add subscription**, **Add API provider**, or **Import current Codex setup** to detect an API or subscription already configured on this computer. An empty Base URL uses the official OpenAI API.
3. Choose **English / 简体中文** and **System / Light / Dark** at the top of the window; your preferences are saved.
4. Restart Codex or reload its editor window once to pick up the local route. Right-click the Windows tray or macOS menu bar icon to switch providers; use the settings window to drag priorities, add or delete providers, and choose model and effort. The top-right globe and appearance icons change language and theme.

Installing alone leaves Codex configuration untouched. Closing the window keeps routing in the tray; **Quit easy-switch** restores the original connection settings. **Start at login** is optional and off by default. Existing clients may need a restart/reload after routing starts or stops. Your Codex conversation client is installed separately.

Windows packages have no publisher signature. macOS packages use ad hoc signing with verified bundle integrity, but have no Developer ID and are not notarized. Your OS may require explicit first-launch approval; see the [macOS preview instructions](docs/desktop.md#macos-preview-and-the-damaged-app-alert). The Apple silicon packaged app is tested on macOS; Intel macOS and Windows installers are built but their runtime behavior still needs verification on those systems. See the [desktop guide](docs/desktop.md) for lifecycle, recovery, network configuration and update instructions.

### 🐧 Linux server CLI

Requires **Linux with systemd/logind, Node.js 22+, npm, Git, and Codex CLI**. Install as the server user that runs Codex or the remote extension.

#### 1. 📦 Clone the project

```bash
git clone https://github.com/JasperRoc/easy-switch.git
cd easy-switch
```

#### 2. ⚙️ Install the tool

```bash
./install.sh
```

The installer registers `switch`, starts the systemd background service, enables boot startup, and backs up and updates Codex configuration. If boot startup requires administrator assistance, follow the installer's instructions. Restart Codex or reload the remote editor window once after installation; subsequent provider switches do not require a restart.

#### 3. ⌨️ Use the commands

| Command | Purpose |
| --- | --- |
| `switch add account <alias>` | Add a subscription account |
| `switch add api <alias>` | Add an official or third-party API |
| `switch <alias>` | Select the provider for subsequent requests |
| `switch list` | Show fallback priority and the active provider (`*`) |
| `switch model` | Choose model and effort for subsequent requests |
| `switch model current` | Show the current model override |
| `switch model reset` | Clear model and effort overrides |
| `switch order` | Adjust priority with the keyboard |
| `switch update` | Update from the official main branch and restart the service |
| `switch current` | Show the active alias |
| `switch service status` | Inspect the background service |
| `switch service restart` | Restart the service; interrupts in-flight requests |
| `switch service uninstall` | Restore configuration and remove the service |
| `switch help` | Show command help |

When adding an API, **leave Base URL blank to use the official OpenAI API** (`https://api.openai.com/v1`) and enter the corresponding OpenAI API key. For a third-party service, enter its Base URL and API key. Third-party URLs should omit `/responses`, and the service must support Responses API, SSE, and Codex tool calls.

In `switch order`, use **↑/↓** to select, **Shift+↑/↓** (or uppercase **K/J**) to move, **Enter** to save, and **Esc** or **Ctrl+C** to cancel. Priority runs from top to bottom. Saving the order does not change the active provider.

Run `switch model` to select a model and then one of its supported efforts. Use **↑/↓** to select, **Enter** to confirm, and **Esc/Ctrl+C** to cancel. Choose “Follow Codex” or run `switch model reset` to clear overrides. The setting applies to subsequent requests across all sessions using the service; existing response streams finish normally. API catalogs come from the provider’s `/models` endpoint, including custom model IDs. Codex metadata supplies known reasoning efforts; unrecognized models use the provider default. Subscription catalogs are read with the selected account in an isolated Codex process. Actual access and Responses/tool compatibility depend on the upstream. This overrides request parameters; it does not synchronize Codex's native model label or client capabilities. See [model and effort switching](docs/usage.md#model-and-effort-switching).

After installation, open a new Bash/Zsh terminal to enable **Tab completion**, such as `switch per<Tab>` for aliases or `switch service re<Tab>` for subcommands. To enable it in the current terminal, run `source ~/.bashrc`, or `source "${ZDOTDIR:-$HOME}/.zshrc"` for Zsh. API setup asks only for the endpoint and key; the model follows the current Codex configuration unless overridden with `switch model`.

Run `switch update` for subsequent updates from any directory. Updates restart the proxy, so wait for active tasks to finish first. Older installations without this command need one initial `git pull --ff-only` followed by `./install.sh`. If version 0.1.1 or earlier blocks an update after changing model settings, use the same source-install steps once.

If your server needs an Internet proxy, set `HTTP_PROXY` / `HTTPS_PROXY` before installation or update. The tool saves these settings for the background service and future updates; loopback addresses always connect directly. See [outbound proxy configuration](docs/usage.md#outbound-network-proxy).

See the [operations guide](docs/usage.md) for authentication, data storage, and failover rules.

<a id="why-easy-switch"></a>

## 🔎 Why easy-switch?

easy-switch targets personal Codex workflows on desktops and Linux servers, focusing on conversation continuity when switching accounts and APIs. Its design emphasizes **a small configuration surface, optional desktop integration, operation over SSH, and explicit control over failover priority**.

| Project | Focus | Where easy-switch fits |
| --- | --- | --- |
| [CC Switch](https://github.com/farion1231/cc-switch) | Desktop management for multiple AI tools, with local routing and automatic failover | Manage providers and priority entirely over SSH, with a systemd service independent of a desktop application. |
| [Sub2API](https://github.com/Wei-Shaw/sub2api) | Subscription gateway with account management and sharing; its documented stack includes PostgreSQL and Redis | Run a personal switching service with local files and Node.js, without deploying a database, cache, or web administration panel. |
| [New API](https://github.com/QuantumNous/new-api) | Unified model aggregation, distribution, and protocol conversion | Connect existing Responses-compatible providers directly to a Codex workflow, without configuring a broader distribution platform. |

easy-switch brings account configuration, routing selection, model selection, and fallback ordering into a tray application or command-line interface, reducing configuration and maintenance steps for individual users. Its distinction lies primarily in deployment and interaction design; request-level hot switching is not unique to this project.

<a id="faq"></a>

## ❓ FAQ

### Will other AI providers be supported?

The official OpenAI API and Responses-compatible third-party APIs can already be added with `switch add api`. Native Claude, Gemini, and other subscription login flows are not implemented. Broader provider support is a possible direction, but has no committed release date; it requires authentication, protocol, and tool-call compatibility work.

### Will macOS and Windows be supported?

Windows x64 and macOS Apple silicon/Intel desktop installers are available alongside the Linux systemd CLI. Desktop routing follows the application lifetime; Linux routing follows its systemd service. Apple silicon macOS has packaged-app tests; Windows and Intel macOS need native runtime validation. See the [desktop guide](docs/desktop.md).

### Does switching interrupt the current task?

Manual changes apply to subsequent model requests in the same session. Eligible upstream rejections can be retried through alternatives before a successful response stream starts. Mid-stream failures, unsupported context formats, or an exhausted queue can still interrupt the task. This is not a guarantee of recovery from every failure.

<a id="disclaimer"></a>

## ⚠️ Disclaimer

easy-switch is an independent community project, not affiliated with or endorsed by OpenAI. Use only accounts and APIs you are authorized to access, and follow the applicable providers' terms. Switching providers sends the required conversation history to the selected provider. Credentials are stored locally with file-permission protection.

This project is experimental. Same-session switching is tested with a real Codex process and simulated upstreams; real-provider access, the VS Code Remote interface, and server reboot recovery still require end-to-end validation. Read the full [disclaimer](docs/DISCLAIMER.md) and [operational limits](docs/usage.md#protocol-support-and-limits) before deployment.

<a id="contributing"></a>

## 🤝 Contributing

Bug reports, compatibility results, documentation improvements, and focused pull requests are welcome. Include reproduction steps and your environment when reporting an issue; remove credentials and private conversation content from logs.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and contribution guidelines.

<a id="license"></a>

## 📄 License

[MIT](docs/LICENSE) © 2026 easy-switch contributors.
