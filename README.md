**English** · [简体中文](docs/README.zh-CN.md)

# easy-switch: A better AI conversation experience

![Node.js](https://img.shields.io/badge/Node.js-22%2B-417E38?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-Linux%20%2B%20systemd-2563EB?style=flat-square)
![Status](https://img.shields.io/badge/Status-Experimental-D97706?style=flat-square)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](docs/LICENSE)

easy-switch is a command-line account and API routing tool for Codex, bringing **ChatGPT subscription accounts, the official OpenAI API, and third-party compatible APIs** into one workflow. It switches providers at model request boundaries while preserving the client process and conversation. Eligible quota or authentication rejections trigger retries through alternatives in the configured priority order.

🔄 **In-session switching** · 🎛️ **Interactive priority management** · ⚙️ **Background operation and automatic failover**

[Quick start](#quick-start) · [Why easy-switch?](#why-easy-switch) · [FAQ](#faq) · [Disclaimer](#disclaimer) · [Contributing](#contributing) · [License](#license)

<a id="quick-start"></a>

## 🚀 Quick start

Requires **Linux with systemd/logind, Node.js 22+, npm, Git, and Codex CLI**. Install as the server user that runs Codex or the remote extension.

### 1. 📦 Clone the project

```bash
git clone https://github.com/JasperRoc/easy-switch.git
cd easy-switch
```

### 2. ⚙️ Install the tool

```bash
./install.sh
```

The installer registers `switch`, starts the systemd background service, enables boot startup, and backs up and updates Codex configuration. If boot startup requires administrator assistance, follow the installer's instructions. Restart Codex or reload the remote editor window once after installation; subsequent provider switches do not require a restart.

### 3. ⌨️ Use the commands

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

Run `switch model` to select a model and then one of its supported efforts. Use **↑/↓** to select, **Enter** to confirm, and **Esc/Ctrl+C** to cancel. Choose “Follow Codex” or run `switch model reset` to clear overrides. The setting applies to subsequent requests across all sessions using the service; existing response streams finish normally. The catalog comes from Codex CLI and is filtered against the API provider's `/models` endpoint when available. Actual support depends on the upstream. This overrides request parameters; it does not synchronize Codex's native model label or client capabilities. See [model and effort switching](docs/usage.md#model-and-effort-switching).

After installation, open a new Bash/Zsh terminal to enable **Tab completion**, such as `switch per<Tab>` for aliases or `switch service re<Tab>` for subcommands. To enable it in the current terminal, run `source ~/.bashrc`, or `source "${ZDOTDIR:-$HOME}/.zshrc"` for Zsh. API setup asks only for the endpoint and key; the model follows the current Codex configuration unless overridden with `switch model`.

Run `switch update` for subsequent updates from any directory. Updates restart the proxy, so wait for active tasks to finish first. Older installations without this command need one initial `git pull --ff-only` followed by `./install.sh`. If version 0.1.1 or earlier blocks an update after changing model settings, use the same source-install steps once.

If your server needs an Internet proxy, set `HTTP_PROXY` / `HTTPS_PROXY` before installation or update. The tool saves these settings for the background service and future updates; loopback addresses always connect directly. See [outbound proxy configuration](docs/usage.md#outbound-network-proxy).

See the [operations guide](docs/usage.md) for authentication, data storage, and failover rules.

<a id="why-easy-switch"></a>

## 🔎 Why easy-switch?

easy-switch targets personal Codex workflows on Linux servers, focusing on conversation continuity when switching accounts and APIs. Its design emphasizes **operation over SSH, fewer deployment dependencies, and explicit control over failover priority**.

| Project | Focus | Where easy-switch fits |
| --- | --- | --- |
| [CC Switch](https://github.com/farion1231/cc-switch) | Desktop management for multiple AI tools, with local routing and automatic failover | Manage providers and priority entirely over SSH, with a systemd service independent of a desktop application. |
| [Sub2API](https://github.com/Wei-Shaw/sub2api) | Subscription gateway with account management and sharing; its documented stack includes PostgreSQL and Redis | Run a personal switching service with local files and Node.js, without deploying a database, cache, or web administration panel. |
| [New API](https://github.com/QuantumNous/new-api) | Unified model aggregation, distribution, and protocol conversion | Connect existing Responses-compatible providers directly to a Codex workflow, without configuring a broader distribution platform. |

easy-switch brings account configuration, routing selection, and fallback ordering into one command-line interface, reducing configuration and maintenance steps for individual users. Its distinction lies primarily in deployment and interaction design; request-level hot switching is not unique to this project.

<a id="faq"></a>

## ❓ FAQ

### Will other AI providers be supported?

The official OpenAI API and Responses-compatible third-party APIs can already be added with `switch add api`. Native Claude, Gemini, and other subscription login flows are not implemented. Broader provider support is a possible direction, but has no committed release date; it requires authentication, protocol, and tool-call compatibility work.

### Will macOS and Windows be supported?

The supported installation target is currently Linux with systemd. Windows/macOS desktop support is not implemented yet. Its planned lifecycle is to enable routing only while the application runs, restore the original configuration on exit, and let users opt into login startup. Cross-platform core tests do not mean desktop installation is already supported.

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
