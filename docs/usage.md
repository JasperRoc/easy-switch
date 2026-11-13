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

`switch add api <alias>` supports OpenAI's official API and third-party Responses-compatible endpoints. Leave Base URL blank to use `https://api.openai.com/v1`, then enter your OpenAI API key. For another provider, enter its Base URL (without `/responses`) and its corresponding key. The resolved URL is saved with the alias and shown by `switch list`. New API entries inherit the request model selected in Codex; setup does not ask for a model override. Text model and effort values come from the client; old easy-switch override fields are ignored.

Edit a saved provider with `switch edit <alias>` or the desktop pencil button. A blank replacement key preserves the existing secret. Renaming keeps its priority, active route and account credential directory; changing an address/key takes effect on subsequent requests. Claude Code uses separate providers and commands prefixed with `switch claude`; see the [Claude Code guide](claude-code.md).

## Provider model lookup

Use the magnifying glass on any desktop provider row to read that provider’s own model catalog. Querying an inactive provider does not select it. The dialog supports editable model IDs and display names, search, fetch, add/delete, drag or keyboard ordering, model count and read time. Changes are saved together, Cancel discards the draft and Use automatic catalog restores provider discovery; failures and empty results are explicit. It never substitutes another provider’s catalog or sends a generation request to test access.

For Codex APIs, discovery uses the configured `/models` endpoint and that provider’s key. Subscriptions read the live Codex `/models?client_version=...` catalog using that account’s token and account ID. Failed discovery never substitutes the client’s bundled list. No thread is started or resumed. Catalog membership alone does not establish model access, Responses compatibility or tool support.

Select models and reasoning effort in Codex or Claude Code itself. easy-switch does not apply global or per-session text model overrides, including fields saved by older versions, and does not enumerate running tasks. Claude APIs can define a provider-specific naming map for the main model and subagents; see the [Claude Code guide](claude-code.md). If a provider does not expose discovery, consult its documentation for exact IDs.

Codex loads the deduplicated union of all configured provider catalogs through `model_providers.easy_switch.model_catalog_url`, retaining native subscription metadata and exact upstream IDs. Available IDs come only from live provider lists or explicit user entries: there is no fixed or fallback default model set. For exact matching IDs, missing effort/ordering metadata is read once per proxy process from an isolated official Codex helper without credentials, threads or upstream inference; live subscription metadata takes precedence, including explicit empty effort choices. No standalone reference model list is distributed. GPT models are grouped by version series descending (`6.1`, then `6`, then `5.6`); each series retains native variant order. Other models follow in natural name order. Image-only IDs (`gpt-image-*`, `chatgpt-image-*`, `dall-e-*`), image-only output metadata and hidden native entries are excluded from the conversation picker. Image tool routes remain separate. Unknown models do not inherit invented effort options. Provider priority controls routing rather than menu order. A fresh provider catalog that excludes a model is skipped; discovery failure leaves support unknown so inference can still be attempted. Catalogs are fetched on demand and cached for one minute, scoped to credentials and provider edits, with no polling. Restart Codex/reload the editor after upgrading to enable discovery. Existing `model` preferences are preserved, and an effective user `model_catalog_json` override takes precedence; remove that override yourself if you want the remote union. API keys do not guarantee Responses/tool support.

For Codex, explicit model-access errors (`model_not_found`, `model_not_supported`, access-denial codes or clear English/Chinese messages) in HTTP 400/403/404/422 or startup SSE can try another provider before any output is accepted. The same model and complete history are retained. This request-specific fallback does not change the preferred provider: for example, Free can handle its supported models while an API handles another model. Access rejections are cached only for the provider/model pair for 60 seconds, with at most 256 entries; manual selection clears the cache. Quota cooldowns remain separate. Safety refusals and unrelated parameter errors do not qualify for model-specific fallback. A generic provider HTTP 403 uses ordinary provider failover instead. A native client that blocks the model before sending the request cannot be handled by the proxy.

## Image generation routing

Native Codex `image_gen` generation/edit calls use separate image endpoints rather than the ordinary text request. easy-switch forwards `/v1/images/generations` and `/v1/images/edits`, preserving JSON or multipart bodies, image model parameters and reference-image bytes. When subscription accounts are configured, only usable subscriptions are selected for these requests, in priority order; the text provider, client-selected text model and global failover selection remain unchanged. Image-only cooldowns are separate from text cooldowns. Native image request originator, User-Agent, image-turn ID and turn metadata are preserved, while credentials are replaced with the selected image provider’s own credentials. Successful and failed image responses identify the actual image alias and preserve the upstream image request ID. An exhausted rejection reports the attempted image providers; it does not imply the selected text API received the image request. Cached plan claims and an unexpired token do not establish live image entitlement. Without subscriptions, image requests go to the selected API and eligible API alternatives. Policy refusals and ordinary validation errors are not bypassed.

Known Free accounts are excluded from image selection because Codex image generation is unavailable on that plan. If there is no eligible subscription, a configured API may handle image requests that reach the proxy. With only Free accounts and no API, the proxy reports the missing image entitlement without starting login or sending a paid request. Explicit plan/model-access rejections, including startup SSE errors, can try another eligible subscription before output; content-policy refusals do not trigger fallback; a generic provider HTTP 403 uses ordinary provider failover.

Desktop activation enables `features.image_generation` and native subscription authentication, with a dedicated local routing header. Existing file-based native subscription credentials are preserved. If Codex was using API authentication or keychain-only credentials, an account added to easy-switch supplies a temporary file-based native sign-in; the previous auth file, credential-store selection and tool settings are backed up and restored on stop, exit or recovery. A separate native sign-in made by the user is preserved. Native token refreshes are copied back only if the app’s account cache has not changed. Adding a subscription while routing is running performs the same setup. **Reload an already-open Codex client once after this change**: a proxy cannot retroactively add tools to its existing client tool registry. Subsequent provider switches keep the tool available. Removing the supplying subscription removes its temporary sign-in or uses another configured subscription. The Linux CLI installer retains its existing API-mode configuration. Requests sent directly to other endpoints, shell scripts or external image servers do not pass through this routing.

Built-in images use subscription quota and remain subject to that account’s limits and permissions. The native protocol is covered by real Codex tests using isolated API, native-subscription and temporary-subscription homes. A live subscription image endpoint has also been verified; availability remains account-dependent. See [official Codex image generation](https://learn.chatgpt.com/docs/image-generation).

When a native Free login prevents tool registration, the desktop app temporarily borrows an added non-Free account for the tool identity, preserving the selected text route and restoring the Free login afterward. Adding that paid account while the app runs is supported; reload the existing Codex client once. With only Free credentials, the app shows the restriction instead of claiming image tools are ready. An image API alone cannot add a tool missing from that running client's registry. See [official Free-plan image limits](https://learn.chatgpt.com/docs/pricing).

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
| `SWITCH_CLAUDE_BIN` | Detected official `claude` executable | Claude subscription sign-in helper |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude user settings and existing sign-in to connect/import |

Use the same `SWITCH_HOME` when installing and switching. Each server user currently has one managed service instance. Codex and the editor do not need these variables for ordinary use once configured.

```text
~/.codex-switch/
├── installation.json       # Original Codex configuration and installation metadata
├── state.json              # Aliases, API keys, selection, local proxy token
├── network.json            # Saved outbound proxy settings
└── accounts/
    └── <account-id>/
        └── auth.json       # Subscription credentials
```

Credentials are plaintext. Directories are created with POSIX mode `0700`; state and authentication files use `0600`. The installed Codex configuration also contains a local proxy token and is written with mode `0600`. Codex credentials have no encrypted vault; Claude imports can read the official Keychain. See [Claude Code](claude-code.md) for its separate credential store. Keep configuration and backups out of source control.

The proxy binds only to IPv4 loopback and requires a random local token. It reconstructs upstream authentication headers rather than forwarding client credentials, requires HTTPS for remote API endpoints, and rejects redirects. Conversation history needed by subsequent requests is sent to the selected provider.

## Protocol support and limits

This section describes the Codex route. Claude Messages, its model-discovery endpoint, subscription login and separate state are described in the [Claude Code guide](claude-code.md).

- Accepts SSE responses with a missing `Content-Type` only after checking the initial body bytes for SSE fields. Explicit non-SSE content types and HTML/JSON bodies without the header are rejected. Buffered bytes are preserved and client cancellation still stops forwarding.
- Supports HTTP SSE at `POST /v1/responses`, plus JSON/multipart image generation and edits at `POST /v1/images/generations` and `POST /v1/images/edits`. Serves the native Codex catalog at authenticated `GET /v1/models`. Does not proxy WebSockets, convert Chat Completions or implement remote compaction.
- Replays ordinary messages and complete tool calls/results. Removes `reasoning` items, so hidden reasoning continuity and cache efficiency may differ from direct use.
- Rejects `previous_response_id`, server-side conversations, item references, and encrypted compaction items. Long or previously compacted conversations may require a new thread with a readable summary.
- The model ID is preserved across providers. Display names only label catalog entries; they do not change protocol, image, tool, reasoning or context capabilities.
- Request bodies are limited to 32 MiB. Raw upstream error bodies are not echoed. Authentication challenges are generated locally from the official device flow.
- No mid-response migration. Only eligible upstream rejections are retried through available alternatives before output or tool events are accepted. Startup SSE capacity errors can also be intercepted within a bounded 64 KiB preamble. Client disconnection cancels transport but does not guarantee upstream billing stops.

Real-Codex/mock-upstream tests verify configuration loading and same-thread switching. Real-provider authentication, the VS Code Remote UI, and actual server reboot recovery remain unverified end to end.


## Automatic failover

HTTP 401, 402, 403 and 429 rejections are eligible for failover before output. Generic provider 403 errors, including HTML/empty responses and startup SSE permission errors, can try an available backup. Explicit content-safety, regional or organization-policy restrictions are preserved. Exhausted HTTP errors report the attempted aliases without exposing raw upstream error bodies. Explicit model-capacity rejections (such as `server_overloaded` or “Selected model is at capacity”) are also eligible, including `error` / `response.failed` events in a Responses SSE startup preamble before any output is accepted. Available alternatives are tried in priority order, each at most once. If no alternative remains, capacity errors get at most two additional same-provider retries with 1/2-second exponential backoff. Retry-After can extend each wait up to 30 seconds; a longer value is never shortened and stops internal retries. Manual provider changes and client cancellation are respected. The selected model/effort and replayable tool results are retained. No output, tool call, unknown SSE event, or already-ended turn is replayed or automatically restarted. HTTP 500/502/503/504/529 and connection failures before accepted output also try available backups, without replaying accepted output or silently changing the model. Other parameter errors are returned; the client can independently retry.

Candidates must have configured API credentials or a readable, unexpired subscription credential cache. Candidates follow `switch order`, highest priority first, regardless of type. Run `switch list` to view numbered priorities and the active alias (`*`). Run `switch order` in an interactive terminal: ↑/↓ selects, Shift+↑/↓ or uppercase K/J moves, Enter saves, and Esc or Ctrl+C cancels. Noninteractive callers can use `switch order <alias> ...` with every configured alias exactly once. Defaults and legacy states use addition order; new aliases are appended. Reordering preserves the active alias and cooldowns, and applies to new requests without restarting the service. In-flight requests retain their ordering snapshot. This local check does not guarantee upstream acceptance. Failed providers are excluded from fallback selection for 60 seconds within the running proxy process. Restarting the service clears cooldowns. Explicit manual selection resets cooldowns on the next request and can select a cooling-down provider.

Selection is persisted before the alternate request, so subsequent requests use that alias even if the alternate fails. A generation check prevents an old failure from overwriting a newer selection. Retries stop on success, an ineligible error, or queue exhaustion. If the active selection changes while a rejected request is pending, that request can continue on the newly selected, untried alias without overwriting the selection. The attempt budget is bounded by the provider count when the request began. The state file records the last failover's aliases, HTTP status, and timestamp.

Local missing/expired subscription credentials and upstream account HTTP 401 first attempt eligible failover; if none succeeds in selecting an alternate, it starts device authentication. Authentication completion itself does not retry a request.

Full replayable conversation input and tool results are sent to the alternative. Hidden reasoning and upstream response references cannot be transferred. This implementation keeps the existing multi-account device-login workflow and background service; it does not copy the source server's Codex launcher or native OAuth forwarding design.
