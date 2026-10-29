# Operations guide

[English README](../README.md) · [简体中文 README](README.zh-CN.md)

For Windows/macOS installers and application-scoped routing, see the [desktop guide](desktop.md). This guide covers the Linux CLI and shared routing behavior.

## Installation and updates

Run `./install.sh` from the repository as the server user that runs Codex. The script installs dependencies, globally installs `switch`, and invokes the internal service setup. Do not run the script with sudo; configure a writable user-level npm prefix if needed.

The installer requires Linux with systemd/logind and a working `systemctl --user` session. It enables linger, registers the user service, checks service health and enabled status, then backs up and edits the user's Codex configuration. If permissions prevent enabling linger, ask an administrator to run:

```bash
sudo loginctl enable-linger <server-user>
```

Then rerun `./install.sh` as the original user. Linger allows the user's service manager to start at boot and remain running after logout.

Run `switch update` to install the latest code from `https://github.com/JasperRoc/easy-switch.git` on the `main` branch. Git and npm must be available, and the global npm prefix must be writable by the current user. The command downloads a temporary checkout, installs a packed archive, and reruns service setup using the recorded state directory, Codex configuration location, and port. Accounts and priority remain in place. It does not modify your source checkout. Updates restart the proxy and interrupt in-flight requests; run them between tasks.

Proxy connection settings are checked before replacing the installed package. Changes to model preferences, unrelated settings, or comments do not block updates and are preserved. Changes to the selected provider, managed provider block, installation path, or port stop the update. Download failures leave the installed package unchanged. A failure after package replacement may require rerunning `./install.sh`; updates do not provide automatic rollback. Older installations without `switch update` need one `git pull --ff-only` followed by `./install.sh` first. Versions through 0.1.1 also require this one-time source update if the old updater rejects a normal model preference change before downloading the fix.

The service stores absolute Node, application, and Codex paths plus the installation PATH. Keep those runtimes installed. Packages are installed from archives, so the service does not depend on the source checkout. Setup leaves existing Codex configuration text untouched when the proxy connection settings still match the installation record. Uninstall retains its stricter restoration check to avoid losing user edits.

The shell installer manages Linux systemd services. Windows and macOS use the [desktop application](desktop.md). Containers without systemd need an external process supervisor.

## Outbound network proxy

The local switching proxy and an outbound Internet proxy have separate roles:

```text
Codex → easy-switch (127.0.0.1:18345) → HTTP/HTTPS proxy → selected provider
```

If the server needs a proxy to reach ChatGPT or an API, export its address in the terminal before installing or updating:

```bash
export HTTP_PROXY=http://127.0.0.1:20000
export HTTPS_PROXY=http://127.0.0.1:20000
switch update
```

For a first installation, run `./install.sh` instead of `switch update`. Replace the example port with your proxy's HTTP or mixed port. SOCKS-only URLs are not supported. Lowercase `http_proxy`, `https_proxy`, `all_proxy`, and `no_proxy` take precedence over their uppercase variants. `ALL_PROXY` is a fallback when the corresponding HTTP/HTTPS setting is absent.

Setup saves the effective settings in `$SWITCH_HOME/network.json` with mode `0600`. The daemon reads this file on startup, so systemd does not need to inherit your terminal environment. Subsequent updates also pass the saved settings to Git, npm, and device-login processes. If there are no saved settings, the first update still needs a terminal with working proxy variables so the old updater can download this fix.

`NO_PROXY` supports hostnames, domain suffixes, optional ports, and `*` to bypass all proxies. CIDR ranges are not supported by the outbound HTTP client; list the required hosts or domain suffixes instead. `localhost`, `127.0.0.1`, and `::1` always bypass the proxy. Proxy authentication remains separate from the upstream API/account credentials, and TLS certificate validation stays enabled. The proxy does not fall back to a direct connection if the configured Internet proxy fails.

To change the proxy, export new values and run `switch update` or rerun `./install.sh`. To disable it, export empty values for both uppercase and lowercase HTTP/HTTPS/ALL proxy variables before setup. Service uninstall retains the saved network settings along with account data. Keep `network.json` private because proxy URLs may contain credentials.

## Remote editor configuration

The Codex extension must actually run on the server under the same user and `CODEX_HOME` as the CLI. A Remote SSH window does not by itself prove that an extension runs remotely.

In the Codex extension, open Codex Settings → Open config.toml and check that this is the server configuration edited by the installer. Reload the remote window after first installation. The local proxy authentication header is stored in that configuration; no shell environment inheritance or custom extension executable setting is required.

If the extension runs on your local machine, its `127.0.0.1` points to your local machine. It will not reach the server proxy automatically. Profiles or command-line provider overrides can also bypass the installed route.

## Shell completion

Setup installs Bash and Zsh completion scripts under `~/.local/share/easy-switch/completions` and adds a managed source block to `~/.bashrc` and `${ZDOTDIR:-$HOME}/.zshrc`. Existing configuration is preserved; repeated setup replaces the same block. Open a new shell or source its rc file to activate completion. Zsh completion initializes `compinit` if needed.

Tab completes command names, `add api/account`, service actions, and saved aliases; `order` excludes aliases already supplied. It reads only alias names for suggestions, never keys. Fish and other shells are not currently supported. Service uninstall retains these shell settings along with account data.

## API providers

`switch add api <alias>` supports OpenAI's official API and third-party Responses-compatible endpoints. Leave Base URL blank to use `https://api.openai.com/v1`, then enter your OpenAI API key. For another provider, enter its Base URL (without `/responses`) and its corresponding key. The resolved URL is saved with the alias and shown by `switch list`. New API entries inherit the request model selected in Codex; setup does not ask for a model override. Existing saved overrides remain compatible.

## Model and effort switching

```bash
switch model          # Interactive model, then effort selection
switch model current  # Display the saved override
switch model reset    # Clear both overrides without opening the picker
```

Use ↑/↓ and Enter to choose, or Esc/Ctrl+C to cancel. Settings are saved only after both steps finish; cancelling either step preserves the previous pair. Selecting Follow Codex clears the global override. Selecting provider-default effort removes the inherited `reasoning.effort` from outgoing requests; other reasoning options are retained. Model changes do not change the selected provider, reset cooldowns, or restart Codex/the service.

Subscription catalogs are read through `model/list` in an isolated Codex app-server using a temporary private copy of the selected account credentials. No thread is started or resumed. Temporary files are removed afterward; refreshed credentials are retained only if the original sign-in has not changed concurrently. Model listings remain subject to account access. API metadata uses an unauthenticated local custom provider to read the bundled Codex catalog.

For APIs, the tool also tries the configured provider's `/models` endpoint using that provider's key and the saved network proxy. If available, every returned model ID is offered, including custom IDs absent from Codex metadata. Known IDs retain Codex’s effort options; unknown IDs offer only the provider default. If discovery fails or the endpoint is unavailable, the picker shows the Codex catalog with a notice. No generation request is sent while selecting; upstream compatibility and account access must still be verified in actual use. The effort menu is populated from each model's catalog metadata, not a universal list.

A model/effort pair applies globally to all sessions connected to this service. Each incoming model request snapshots the pair, including automatic failover attempts. A running SSE response keeps its original settings; the next request, including a tool-result continuation within the same task, uses the new pair. Failover does not silently replace the chosen model/effort. A provider rejecting the selected model or effort can still stop the task.

This is a request-level override. It does not update the native Codex model indicator, model-specific instructions, tool definitions, context-window limits, or other client capability settings. Use compatible models and consult `switch model current` for the effective override. The Codex model catalog alone cannot guarantee full compatibility for arbitrary cross-model changes. Existing legacy per-provider model mappings, if present in old state, remain in effect when the global override is cleared.

## Account authentication

Both initial account creation and automatic reauthentication use `codex login --device-auth`. Enable device code login in your ChatGPT account security settings or workspace settings first. Follow the official verification link and enter the one-time code using your browser.

A detected expired token, missing account cache, or subscription upstream HTTP 401 without a successful fallback starts authentication automatically. The proxy returns the verification link and code in the model request's error message. Complete authentication with the original account, then retry the request. The proxy does not force a local browser or native extension window to open, and does not replay a request after authentication completes.

Concurrent requests for the same account share one pending login. The login runs in a temporary private directory; a successful result replaces the original credentials only after identity checks. A failed or mismatched login preserves the previous credentials. Authentication is cancelled after five minutes; failed attempts have a short cooldown before a new flow starts. If the device link is not ready yet, the error asks you to retry shortly. If device authentication is disabled, enable it and retry.

Device codes are only returned to authenticated proxy clients. Raw authentication output and credentials are not written to service logs. The user interface's exact error presentation depends on the Codex client version.

## Service management

```bash
switch service status
switch service restart
journalctl --user -u easy-switch -f
```

The service runs without an open terminal. An explicit service restart stops in-flight streams and pending authentication.

```bash
switch service uninstall
```

Uninstall restores the original configuration and removes the service. If the configuration was edited after installation, restoration stops rather than discarding your changes. The original text is in `installation.json`; merge it manually when necessary. Account data and linger are retained so uninstall does not remove credentials or disrupt unrelated services.

## Configuration and data

| Variable | Default | Purpose |
| --- | --- | --- |
| `SWITCH_HOME` | `~/.codex-switch` | State and account directory |
| `SWITCH_PORT` | `18345` | Local proxy port, written into configuration during installation |
| `SWITCH_CODEX_BIN` | `codex` | Official CLI used for account authentication |
| `CODEX_HOME` | `~/.codex` | Codex configuration to connect during installation |

Use the same `SWITCH_HOME` when installing and switching. Each server user currently has one managed service instance. Codex and the editor do not need these variables for ordinary use once configured.

```text
~/.codex-switch/
├── installation.json       # Original Codex configuration and installation metadata
├── state.json              # Aliases, API keys, selection, local proxy token
├── network.json            # Saved outbound proxy settings
└── accounts/
    └── personal/
        └── auth.json       # Subscription credentials
```

Credentials are plaintext. Directories are created with POSIX mode `0700`; state and authentication files use `0600`. The installed Codex configuration also contains a local proxy token and is written with mode `0600`. There is no encrypted vault or keychain integration. Keep configuration and backups out of source control.

The proxy binds only to IPv4 loopback and requires a random local token. It reconstructs upstream authentication headers rather than forwarding client credentials, requires HTTPS for remote API endpoints, and rejects redirects. Conversation history needed by subsequent requests is sent to the selected provider.

## Protocol support and limits

- Accepts SSE responses with a missing `Content-Type` only after checking the initial body bytes for SSE fields. Explicit non-SSE content types and HTML/JSON bodies without the header are rejected. Buffered bytes are preserved and client cancellation still stops forwarding.
- Supports HTTP SSE at `POST /v1/responses`; does not proxy WebSockets, convert Chat Completions, discover models, or implement remote compaction.
- Replays ordinary messages and complete tool calls/results. Removes `reasoning` items, so hidden reasoning continuity and cache efficiency may differ from direct use.
- Rejects `previous_response_id`, server-side conversations, item references, and encrypted compaction items. Long or previously compacted conversations may require a new thread with a readable summary.
- Model overrides change the request model name only, not the client's capability catalog. Images, tools, reasoning options, and context limits depend on the upstream.
- Request bodies are limited to 32 MiB. Raw upstream error bodies are not echoed. Authentication challenges are generated locally from the official device flow.
- No mid-response migration. Only eligible upstream rejections are retried through available alternatives before streaming starts. Client disconnection cancels transport but does not guarantee upstream billing stops.

Real-Codex/mock-upstream tests verify configuration loading and same-thread switching. Real-provider authentication, the VS Code Remote UI, and actual server reboot recovery remain unverified end to end.


## Automatic failover

The proxy ports the server implementation's pre-response policy: HTTP 401, 402, 429, and quota-related 403 rejections are eligible. It tries available alternatives, each alias at most once per incoming request. Other errors, network failures, and accepted SSE streams are not replayed. A client can independently retry a failed request.

Candidates must have configured API credentials or a readable, unexpired subscription credential cache. Candidates follow `switch order`, highest priority first, regardless of type. Run `switch list` to view numbered priorities and the active alias (`*`). Run `switch order` in an interactive terminal: ↑/↓ selects, Shift+↑/↓ or uppercase K/J moves, Enter saves, and Esc or Ctrl+C cancels. Noninteractive callers can use `switch order <alias> ...` with every configured alias exactly once. Defaults and legacy states use addition order; new aliases are appended. Reordering preserves the active alias and cooldowns, and applies to new requests without restarting the service. In-flight requests retain their ordering snapshot. This local check does not guarantee upstream acceptance. Failed providers are excluded from fallback selection for 60 seconds within the running proxy process. Restarting the service clears cooldowns. Explicit manual selection resets cooldowns on the next request and can select a cooling-down provider.

Selection is persisted before the alternate request, so subsequent requests use that alias even if the alternate fails. A generation check prevents an old failure from overwriting a newer selection. Retries stop on success, an ineligible error, or queue exhaustion. If the active selection changes while a rejected request is pending, that request can continue on the newly selected, untried alias without overwriting the selection. The attempt budget is bounded by the provider count when the request began. The state file records the last failover's aliases, HTTP status, and timestamp.

Local missing/expired subscription credentials still start device authentication immediately. An upstream account HTTP 401 first attempts eligible failover; if none succeeds in selecting an alternate, it starts device authentication. Authentication completion itself does not retry a request.

Full replayable conversation input and tool results are sent to the alternative. Hidden reasoning and upstream response references cannot be transferred. This implementation keeps the existing multi-account device-login workflow and background service; it does not copy the source server's Codex launcher or native OAuth forwarding design.
