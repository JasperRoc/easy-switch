# Operations guide

[English README](../README.md) · [简体中文 README](README.zh-CN.md)

## Installation and updates

Run `./install.sh` from the repository as the server user that runs Codex. The script installs dependencies, globally installs `switch`, and invokes the internal service setup. Do not run the script with sudo; configure a writable user-level npm prefix if needed.

The installer requires Linux with systemd/logind and a working `systemctl --user` session. It enables linger, registers the user service, checks service health and enabled status, then backs up and edits the user's Codex configuration. If permissions prevent enabling linger, ask an administrator to run:

```bash
sudo loginctl enable-linger <server-user>
```

Then rerun `./install.sh` as the original user. Linger allows the user's service manager to start at boot and remain running after logout.

Run `switch update` to install the latest code from `https://github.com/JasperRoc/easy-switch.git` on the `main` branch. Git and npm must be available, and the global npm prefix must be writable by the current user. The command downloads a temporary checkout, installs a packed archive, and reruns service setup using the recorded state directory, Codex configuration location, and port. Accounts and priority remain in place. It does not modify your source checkout. Updates restart the proxy and interrupt in-flight requests; run them between tasks.

Configuration conflicts are checked before replacing the installed package. Download failures leave the installed package unchanged. A failure after package replacement may require rerunning `./install.sh`; updates do not provide automatic rollback. Older installations without `switch update` need one `git pull --ff-only` followed by `./install.sh` first.

The service stores absolute Node, application, and Codex paths plus the installation PATH. Keep those runtimes installed. Packages are installed from archives, so the service does not depend on the source checkout. If Codex configuration has changed since installation, setup refuses to overwrite it; merge or restore the configuration first.

Only Linux systemd installation is supported. Other platforms can run core tests, but do not have automatic service installation. Containers without systemd need an external process supervisor.

## Remote editor configuration

The Codex extension must actually run on the server under the same user and `CODEX_HOME` as the CLI. A Remote SSH window does not by itself prove that an extension runs remotely.

In the Codex extension, open Codex Settings → Open config.toml and check that this is the server configuration edited by the installer. Reload the remote window after first installation. The local proxy authentication header is stored in that configuration; no shell environment inheritance or custom extension executable setting is required.

If the extension runs on your local machine, its `127.0.0.1` points to your local machine. It will not reach the server proxy automatically. Profiles or command-line provider overrides can also bypass the installed route.

## Shell completion

Setup installs Bash and Zsh completion scripts under `~/.local/share/easy-switch/completions` and adds a managed source block to `~/.bashrc` and `${ZDOTDIR:-$HOME}/.zshrc`. Existing configuration is preserved; repeated setup replaces the same block. Open a new shell or source its rc file to activate completion. Zsh completion initializes `compinit` if needed.

Tab completes command names, `add api/account`, service actions, and saved aliases; `order` excludes aliases already supplied. It reads only alias names for suggestions, never keys. Fish and other shells are not currently supported. Service uninstall retains these shell settings along with account data.

## API providers

`switch add api <alias>` supports OpenAI's official API and third-party Responses-compatible endpoints. Leave Base URL blank to use `https://api.openai.com/v1`, then enter your OpenAI API key. For another provider, enter its Base URL (without `/responses`) and its corresponding key. The resolved URL is saved with the alias and shown by `switch list`. New API entries inherit the request model selected in Codex; setup does not ask for a model override. Existing saved overrides remain compatible.

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
└── accounts/
    └── personal/
        └── auth.json       # Subscription credentials
```

Credentials are plaintext. Directories are created with POSIX mode `0700`; state and authentication files use `0600`. The installed Codex configuration also contains a local proxy token and is written with mode `0600`. There is no encrypted vault or keychain integration. Keep configuration and backups out of source control.

The proxy binds only to IPv4 loopback and requires a random local token. It reconstructs upstream authentication headers rather than forwarding client credentials, requires HTTPS for remote API endpoints, and rejects redirects. Conversation history needed by subsequent requests is sent to the selected provider.

## Protocol support and limits

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
