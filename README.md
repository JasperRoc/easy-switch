**English** · [简体中文](docs/README.zh-CN.md)

# easy-switch: A better AI conversation experience

![Node.js](https://img.shields.io/badge/Node.js-22%2B-417E38?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-2563EB?style=flat-square)
![Status](https://img.shields.io/badge/Status-Experimental-D97706?style=flat-square)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](docs/LICENSE)

easy-switch is a desktop and command-line routing tool for **Codex, Claude Code CLI and Claude Desktop**. Manage ChatGPT and Claude subscriptions, official APIs, and compatible third-party APIs. Codex and Claude have independent provider lists and fallback priorities; Claude CLI and Desktop share the Claude list. Switch at model request boundaries while keeping the client process and conversation; eligible quota or authentication rejections try alternatives in priority order.

🔄 **In-session switching** · 🖥️ **Tray and menu bar controls** · 🌊 **Ocean glass UI · EN / 中文 · Light / dark** · 🔍 **Provider model lookup** · ⚙️ **Automatic failover**

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
2. Select **Codex** or **Claude**, then use **Add subscription**, **Add API provider**, or **Import existing sign-in**. An empty Base URL uses that client’s official API: OpenAI for Codex, Anthropic for Claude. Claude subscription sign-in uses your separately installed official Claude Code CLI and browser; macOS may request Keychain access.
3. Choose **English / 简体中文** and **System / Light / Dark** at the top of the window; your preferences are saved.
4. Restart the selected client or reload its editor window once to read the local route. Click the tray/menu bar icon to reopen the window; right-click to select a client and switch providers. Drag provider priorities, edit an alias/address/key with the pencil button, or delete a provider. A blank key in the edit dialog preserves the saved key. Click a provider’s magnifying glass to query its own model catalog without changing the active route. Select models and reasoning effort in the conversation client; Claude API entries also support optional main/subagent model mappings.

Installing alone leaves client configuration untouched. Closing the window keeps routing in the tray; **Quit easy-switch** restores the original connection settings for all clients. **Start at login** is optional and off by default. Existing clients may need a restart/reload after routing starts or stops. Conversation clients are installed separately. See the [Claude guide](docs/claude-code.md) for authentication and protocol details.

Claude CLI and Desktop use separate configuration adapters with one shared route. An initialized Claude Desktop installation is automatically connected through its third-party inference profile; fully quit and reopen Desktop after routing starts or stops. While routing remains active, provider changes apply to subsequent model requests without rewriting that profile. Outbound connections are configured automatically at startup from your environment or system HTTP/HTTPS proxy settings; existing saved overrides are retained.

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
| `switch edit <alias>` | Edit alias, Base URL or key; a blank key preserves it |
| `switch <alias>` | Select the provider for subsequent requests |
| `switch list` | Show fallback priority and the active provider (`*`) |
| `switch claude add api <alias>` | Add an Anthropic Messages API for Claude Code |
| `switch claude add account <alias>` | Add or renew a Claude subscription through official sign-in |
| `switch claude <alias>` | Switch Claude Code without changing Codex |
| `switch claude list / order` | Manage Claude’s independent providers and priorities |
| `switch order` | Adjust priority with the keyboard |
| `switch update` | Update from the official main branch and restart the service |
| `switch current` | Show the active alias |
| `switch service status` | Inspect the background service |
| `switch service restart` | Restart the service; interrupts in-flight requests |
| `switch service uninstall` | Restore configuration and remove the service |
| `switch help` | Show command help |

When adding an API, **leave Base URL blank to use the official OpenAI API** (`https://api.openai.com/v1`) and enter the corresponding OpenAI API key. For a third-party service, enter its Base URL and API key. Third-party URLs should omit `/responses`, and the service must support Responses API, SSE, and Codex tool calls.

In `switch order`, use **↑/↓** to select, **Shift+↑/↓** (or uppercase **K/J**) to move, **Enter** to save, and **Esc** or **Ctrl+C** to cancel. Priority runs from top to bottom. Saving the order does not change the active provider.

Model and reasoning-effort selection stays in Codex or Claude Code. The desktop magnifying glass queries the selected row’s provider, including inactive providers, and shows a searchable catalog with refresh status. A listed model does not prove inference or tool permissions. See [provider model lookup](docs/usage.md#provider-model-lookup) and [Claude model mappings](docs/claude-code.md).

After installation, open a new Bash/Zsh terminal to enable **Tab completion**, such as `switch per<Tab>` for aliases or `switch service re<Tab>` for subcommands. To enable it in the current terminal, run `source ~/.bashrc`, or `source "${ZDOTDIR:-$HOME}/.zshrc"` for Zsh. API setup asks only for the endpoint and key; the model follows the current Codex configuration for text requests.

Run `switch update` for subsequent updates from any directory. Updates restart the proxy, so wait for active tasks to finish first. Older installations without this command need one initial `git pull --ff-only` followed by `./install.sh`. If version 0.1.1 or earlier blocks an update after changing model settings, use the same source-install steps once.

If your server needs an Internet proxy, set `HTTP_PROXY` / `HTTPS_PROXY` before installation or update. The tool saves these settings for the background service and future updates; loopback addresses always connect directly. See [outbound proxy configuration](docs/usage.md#outbound-network-proxy).

See the [operations guide](docs/usage.md) for authentication, data storage, and failover rules.

<a id="why-easy-switch"></a>

## 🔎 Why easy-switch?

easy-switch targets personal Codex and Claude Code workflows on desktops and Linux servers, focusing on conversation continuity when switching accounts and APIs. Its design emphasizes **a small configuration surface, optional desktop integration, operation over SSH, and explicit control over failover priority**.

| Project | Focus | Where easy-switch fits |
| --- | --- | --- |
| [CC Switch](https://github.com/farion1231/cc-switch) | Desktop management for multiple AI tools, with local routing and automatic failover | Manage providers and priority entirely over SSH, with a systemd service independent of a desktop application. |
| [Sub2API](https://github.com/Wei-Shaw/sub2api) | Subscription gateway with account management and sharing; its documented stack includes PostgreSQL and Redis | Run a personal switching service with local files and Node.js, without deploying a database, cache, or web administration panel. |
| [New API](https://github.com/QuantumNous/new-api) | Unified model aggregation, distribution, and protocol conversion | Connect existing Responses-compatible providers directly to a Codex workflow, without configuring a broader distribution platform. |

easy-switch brings account configuration, routing selection and fallback ordering into a tray application or command-line interface, reducing configuration and maintenance steps for individual users. Its distinction lies primarily in deployment and interaction design; request-level hot switching is not unique to this project.

<a id="faq"></a>

## ❓ FAQ

### Will other AI providers be supported?

Codex supports Responses-compatible APIs and ChatGPT subscriptions; Claude Code supports Anthropic Messages-compatible APIs and Claude subscriptions. [DeepSeek documents Codex integration](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/) and [Claude Code integration](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/). Configure each protocol endpoint separately and select a model the provider actually offers; a generic third-party key alone does not establish protocol compatibility. Gemini subscription login is not implemented.

### How does Claude Desktop use a third-party model?

Open Claude Desktop once to initialize its configuration, add a provider under **Claude**, then fully quit and reopen Desktop. easy-switch writes its [third-party inference configuration](https://code.claude.com/docs/en/llm-gateway-connect#desktop-app) separately from CLI settings. For DeepSeek, enter the provider’s exact main/subagent IDs in **Claude model mapping**. Desktop uses stable `easy-switch` Sonnet/Opus/Subagent route entries; the gateway maps them to the current upstream, so switching does not require reloading a provider-specific menu. These role names do not assert access to Claude models. Upstreams must support Anthropic Messages, streaming and tools; only OpenAI Chat compatibility is insufficient. See the [Claude guide](docs/claude-code.md) for paths, restoration and testing limits.

### Why does Codex list a model my API cannot use?

Codex’s native model menu describes its own catalog and sign-in, not the API selected inside easy-switch. easy-switch queries the selected provider’s model endpoint and no longer substitutes the Codex catalog when that query fails. The native menu is not rewritten. A listed model still needs inference/tool permissions; query that provider’s row, then choose a supported model in the client. HTTP 503 alone cannot distinguish a capacity problem from another upstream failure.

If a Codex upstream explicitly rejects a model as missing, unsupported or inaccessible, easy-switch tries the same model through alternatives before accepting output. That fallback keeps the preferred route selected: a Free account can remain preferred for models it supports while an API handles another model. Rejections are cached for that provider/model for 60 seconds; manual provider selection clears the cache. If every provider rejects it, choose another model or add access. Requests blocked inside the client before reaching the proxy cannot be rerouted.

### Will macOS and Windows be supported?

Windows x64 and macOS Apple silicon/Intel desktop installers are available alongside the Linux systemd CLI. Desktop routing follows the application lifetime; Linux routing follows its systemd service. Apple silicon macOS has packaged-app tests; Windows and Intel macOS need native runtime validation. See the [desktop guide](docs/desktop.md).

### Can I see my subscription quota?

Desktop Codex account rows show remaining quota from the account’s usage endpoint: Plus uses one ring with a smaller upper arc for 5-hour quota and a larger lower arc for weekly quota; Pro shows a full weekly ring. Hover an arc to lift it and reveal its remaining percentage and reset time. The compact ring uses a neutral arc design with a center diamond. Hover or focus the center diamond to see purchased credits, independently of time-window limits; the separate balance block is removed. Quota refreshes every minute while the window is visible; hiding or minimizing pauses automatic reads, and failures use increasing retry delays. Clicking no longer expands all details. Missing data and failed reads are shown explicitly; balances are not estimated and reset cards are never redeemed automatically.

### Can I use an earned quota-reset card?

Desktop subscription rows include a reset button. Open it to see individual cards and their expiration dates, choose a card, then confirm its use. Cards are ordered by expiration; expired cards cannot be selected. A missing detail list or expiration is shown explicitly. The app uses the [official account reset methods](https://learn.chatgpt.com/docs/app-server#8-earned-rate-limit-resets-chatgpt), preserves the same idempotency key when retrying an uncertain result, and rereads card details and quota afterward. Resets do not change purchased credits or your selected provider.

### Can a subscription handle image generation while text uses an API?

Yes. Native image generation/edit requests sent through easy-switch prefer available subscription accounts in priority order and leave the selected text provider and model unchanged. Codex must already expose its built-in image tool. On desktop, adding a subscription also configures native image tools and temporarily connects its sign-in when Codex was using API authentication. Reload an already-open Codex client once after this setup; later provider switches keep these tools available. Quitting restores the original connection and any temporary sign-in. See [image routing](docs/usage.md#image-generation-routing).

Free accounts do not provide Codex image generation. easy-switch skips known Free accounts for image requests and can temporarily use an added, eligible paid account to enable the tool when the native login is Free. Reload Codex once afterward. An image API can handle requests reaching the proxy when no eligible subscription exists, but cannot enable a tool that the Free client has disabled. Plan/model access rejections before output can try another account; safety refusals are not retried through alternatives.

### Why does Codex show a subscription sign-in when I select an API?

Desktop image support temporarily connects a native subscription so Codex can expose its built-in image tool. The account label in Codex therefore describes that native sign-in, while easy-switch selects the actual upstream separately. Selecting an API sends text requests with that API’s key; image requests use a subscription. The app displays this distinction below the provider list. Stopping or quitting easy-switch restores the original configuration and temporary sign-in. Codex’s account card shows one native identity and the easy-switch provider name; additional accounts remain in easy-switch’s scrolling provider list and tray menu.

### Does switching interrupt the current task?

The current provider at the top identifies the default text provider for subsequent requests and changes after successful automatic failover. In-flight requests can still finish on their original provider; image routing is separate. Manual changes apply to subsequent model requests in the same session, including Claude Desktop task continuations. Eligible upstream rejections can be retried through alternatives. A Codex “Selected model is at capacity” rejection in HTTP or startup SSE is handled before any output is accepted: try available providers, then up to two delayed retries. Already accepted text/tool events are never replayed. Mid-stream failures, unsupported context formats, or an exhausted queue can still interrupt the task.

<a id="disclaimer"></a>

## ⚠️ Disclaimer

easy-switch is an independent community project, not affiliated with or endorsed by OpenAI or Anthropic. Use only accounts and APIs you are authorized to access, and follow the applicable providers' terms. Switching providers sends the required conversation history to the selected provider. Credentials are stored locally with file-permission protection.

This project is experimental. Same-session switching is tested with real Codex and Claude Code processes and simulated upstreams; real-provider access, the VS Code Remote interface, and server reboot recovery still require end-to-end validation. Read the full [disclaimer](docs/DISCLAIMER.md) and [operational limits](docs/usage.md#protocol-support-and-limits) before deployment.

<a id="contributing"></a>

## 🤝 Contributing

Bug reports, compatibility results, documentation improvements, and focused pull requests are welcome. Include reproduction steps and your environment when reporting an issue; remove credentials and private conversation content from logs.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and contribution guidelines.

<a id="license"></a>

## 📄 License

[MIT](docs/LICENSE) © 2026 easy-switch contributors.
