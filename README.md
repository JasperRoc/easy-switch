**English** · [简体中文](docs/README.zh-CN.md)

# easy-switch: A better AI conversation experience

easy-switch lets you switch between ChatGPT subscription accounts, the official OpenAI API, and third-party APIs while keeping your Codex session running. Choose a provider with one command, arrange fallback priority with your keyboard, and automatically retry eligible quota failures through available alternatives. A local background service handles routing while you continue using your terminal or server-side VS Code extension.

[Quick start](#quick-start) · [Why easy-switch?](#why-easy-switch) · [FAQ](#faq) · [Disclaimer](#disclaimer) · [Contributing](#contributing) · [License](#license)

## Quick start

Requires **Linux with systemd/logind, Node.js 22+, npm, Git, and Codex CLI**. Install as the server user that runs Codex or the remote extension.

### 1. Clone the project

```bash
git clone https://github.com/JasperRoc/easy-switch.git
cd easy-switch
```

### 2. Install the tool

```bash
./install.sh
```

The installer registers `switch`, starts the systemd background service, enables boot startup, and backs up and updates Codex configuration. If boot startup requires administrator assistance, follow the installer's instructions. Restart Codex or reload the remote editor window once after installation; subsequent provider switches do not require a restart.

For VS Code Remote, the Codex extension must run on the server and read the same user's Codex configuration.

### 3. Use the commands

```bash
switch add account personal  # Add a ChatGPT subscription account
switch add api relay         # Add an official or third-party API
switch personal              # Select a provider
codex                        # Start Codex normally
```

Account setup uses the official device sign-in flow; device code login must be enabled for your account or workspace. API setup prompts for the Base URL, API key, and optional model name. Leave Base URL blank for the official OpenAI API (`https://api.openai.com/v1`), or enter a third-party endpoint. Use the API key issued by the selected provider. Providers must support **Responses API, SSE, and Codex tool calls**. Use a Base URL such as `https://your-provider.example/v1`, without `/responses`.

While a task is running, execute `switch relay` in another terminal on the same server. Subsequent model requests use the selected provider in the existing conversation. Responses already streaming finish on their original provider.

| Command | Purpose |
| --- | --- |
| `switch add account <alias>` | Add a subscription account |
| `switch add api <alias>` | Add an API provider |
| `switch <alias>` | Select the provider for subsequent requests |
| `switch list` | Show fallback priority and the active provider (`*`) |
| `switch order` | Adjust priority with the keyboard |
| `switch current` | Show the active alias |
| `switch service status` | Inspect the background service |
| `switch service restart` | Restart the service; interrupts in-flight requests |
| `switch service uninstall` | Restore configuration and remove the service |
| `switch help` | Show command help |

In `switch order`, use **↑/↓** to select, **Shift+↑/↓** (or uppercase **K/J**) to move, **Enter** to save, and **Esc** or **Ctrl+C** to cancel. Priority runs from top to bottom. Saving the order does not change the active provider.

See the [operations guide](docs/usage.md) for authentication, data storage, and failover rules.

## Why easy-switch?

easy-switch focuses on one workflow: keeping a personal Codex task moving while switching accounts and APIs on a Linux server. Its advantages are terminal access, a small deployment footprint, and direct control over fallback order.

| Project | Focus | Where easy-switch fits |
| --- | --- | --- |
| [CC Switch](https://github.com/farion1231/cc-switch) | Desktop management for multiple AI tools, with local routing and automatic failover | Manage providers and priority entirely over SSH, with a systemd service independent of a desktop application. |
| [Sub2API](https://github.com/Wei-Shaw/sub2api) | Subscription gateway with account management and sharing; its documented stack includes PostgreSQL and Redis | Run a personal switching service with local files and Node.js, without deploying a database, cache, or web administration panel. |
| [New API](https://github.com/QuantumNous/new-api) | Unified model aggregation, distribution, and protocol conversion | Connect existing Responses-compatible providers directly to a Codex workflow, without configuring a broader distribution platform. |

The practical benefit is a short path from adding an account to switching a running task: **install once, add aliases, choose an order, and continue using Codex**. These projects also provide routing capabilities; easy-switch's distinction is its focused CLI workflow, not an exclusive hot-switching mechanism. It currently supports fewer tools, protocols, and operating systems.

## FAQ

### Will other AI providers be supported?

Responses-compatible third-party APIs can already be added with `switch add api`. Native Claude, Gemini, and other subscription login flows are not implemented. Broader provider support is a possible direction, but has no committed release date; it requires authentication, protocol, and tool-call compatibility work.

### Will macOS and Windows be supported?

The supported installation target is currently Linux with systemd. Native macOS and Windows service installation are possible future extensions, without a committed schedule. Cross-platform core tests do not mean background installation is supported on those platforms.

### Does switching interrupt the current task?

Manual changes apply to subsequent model requests in the same session. Eligible HTTP 401, 402, 429, and quota-related 403 rejections can be retried through the fallback queue before a successful stream starts. Mid-stream failures, unsupported context formats, or an exhausted queue can still interrupt the task. This is not a guarantee of recovery from every failure.

### Does each conversation have its own provider?

No. All sessions connected to one easy-switch service share the selected alias and fallback order. Switching affects subsequent requests from all of them.

### Do I need to keep a terminal open? What happens when login expires?

The proxy runs under systemd and continues after logout. If local subscription credentials expire, or an account returns 401 without an available fallback, it starts official device authentication and returns the verification link and code in the request error. Complete authentication and retry; it does not silently renew tokens.

## Disclaimer

easy-switch is an independent community project, not affiliated with or endorsed by OpenAI. Use only accounts and APIs you are authorized to access, and follow the applicable providers' terms. Switching providers sends the required conversation history to the selected provider. Credentials are stored locally with file-permission protection.

This project is experimental. Same-session switching is tested with a real Codex process and simulated upstreams; real-provider access, the VS Code Remote interface, and server reboot recovery still require end-to-end validation. Read the full [disclaimer](docs/DISCLAIMER.md) and [operational limits](docs/usage.md#protocol-support-and-limits) before deployment.

## Contributing

Bug reports, compatibility results, documentation improvements, and focused pull requests are welcome. Include reproduction steps and your environment when reporting an issue; remove credentials and private conversation content from logs.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and contribution guidelines.

## License

[MIT](docs/LICENSE) © 2026 easy-switch contributors.
