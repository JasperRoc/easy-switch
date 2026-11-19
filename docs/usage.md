# Operations guide

[English README](../README.md) · [简体中文 README](README.zh-CN.md)

For Windows/macOS installers and application-scoped routing, see the [desktop guide](desktop.md). This guide covers the Linux CLI and shared routing behavior.

## Installation and updates

Run `./install.sh` from the repository as the server user that runs Codex. The script installs its production package under `~/.local/share/easy-switch` and a launcher at `~/.local/bin/switch`, then invokes service setup. It uses Node.js 20.18.1+ and npm when available, otherwise it downloads a pinned official Node.js runtime into the same user directory and checks its SHA-256. System Node and global npm settings are unchanged; do not run with sudo. No desktop development dependencies are installed.

The installer requires Linux with systemd/logind and a working `systemctl --user` session. It enables linger, registers the user service, checks service health and enabled status, then backs up and edits the user's Codex configuration. If permissions prevent enabling linger, ask an administrator to run:

```bash
sudo loginctl enable-linger <server-user>
```

Then rerun `./install.sh` as the original user. Linger allows the user's service manager to start at boot and remain running after logout.

Run `switch update` to install the latest code from `https://github.com/JasperRoc/easy-switch.git` on the `main` branch. Git must be available; the installer reuses the supported runtime and needs no writable global npm prefix. The command downloads a temporary checkout, installs a packed archive, and reruns service setup using the recorded state directory, Codex configuration location, and port. Accounts and priority remain in place. It does not modify your source checkout. Updates restart the proxy and interrupt in-flight requests; run them between tasks.

Proxy connection settings are checked before replacing the installed package. Changes to model preferences, unrelated settings, or comments do not block updates and are preserved. Changes to the selected provider, managed provider block, installation path, or port stop the update. Download failures leave the installed package unchanged. A failure after package replacement may require rerunning `./install.sh`; updates do not provide automatic rollback. Older global installations running under an outdated default shell Node.js also need a one-time source reinstall (`git pull --ff-only`, then `./install.sh`) to reach the current-user updater. Older installations without `switch update` need one `git pull --ff-only` followed by `./install.sh` first. Versions through 0.1.1 also require this one-time source update if the old updater rejects a normal model preference change before downloading the fix.

The service stores absolute Node, application, and Codex paths plus the installation PATH. Keep those runtimes installed. Packages are installed from archives, so the service does not depend on the source checkout. Setup preserves model preferences and unrelated configuration text, while migrating legacy model discovery and portable compaction settings. Codex can be found in PATH, `~/.local/bin`, or its VS Code Remote extension. Uninstall retains its stricter restoration check to avoid losing user edits.

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

To change the proxy, export new values and run `switch update` or rerun `./install.sh`. To disable it, export empty values for both uppercase and lowercase HTTP/HTTPS/ALL proxy variables before setup. Complete uninstall removes the saved network settings along with easy-switch’s account copies. Keep `network.json` private because proxy URLs may contain credentials.

## Remote editor configuration

The Codex extension must actually run on the server under the same user and `CODEX_HOME` as the CLI. A Remote SSH window does not by itself prove that an extension runs remotely.

In the Codex extension, open Codex Settings → Open config.toml and check that this is the server configuration edited by the installer. Reload the remote window after first installation. The local proxy authentication header is stored in that configuration; no shell environment inheritance or custom extension executable setting is required.

If the extension runs on your local machine, its `127.0.0.1` points to your local machine. It will not reach the server proxy automatically. Profiles or command-line provider overrides can also bypass the installed route.

## Shell completion

Setup installs Bash and Zsh completion scripts under `~/.local/share/easy-switch/completions` and adds `~/.local/bin` to PATH together with a managed source block to `~/.bashrc` and `${ZDOTDIR:-$HOME}/.zshrc`. Existing configuration is preserved; repeated setup replaces the same block. Open a new shell or source its rc file to activate completion. Zsh completion initializes `compinit` if needed.

Tab completes `codex` / `claude`, command names, `add api/account`, `edit` / `remove` aliases, service actions, and saved aliases; `order` excludes aliases already supplied. Client-prefixed suggestions use only that client’s providers. It reads only alias names for suggestions, never keys. Fish and other shells are not currently supported. Complete uninstall removes only the generated completion files and marked shell blocks, preserving unrelated shell settings.

## Client-specific commands

Run `switch` for a keyboard menu, `switch codex` or `switch claude` to open a client directly, or `switch add` to choose the client and login type. Arrow keys select, Enter confirms and Esc cancels. `switch <alias>` remains the direct Codex shortcut.

Codex and Claude have independent provider lists and fallback queues:

```bash
switch codex add api work
switch codex add account personal
switch claude add api work
switch claude add account personal
switch codex work
switch claude personal
switch codex list
switch claude list
switch codex order
switch claude order
switch current
switch codex current
switch claude current
switch codex remove work
switch claude remove work
```

`switch current` prints two labeled lines, one for Codex and one for Claude. A prefixed `current` prints only that client’s active alias. Missing selections are explicit. The same alias may belong to both clients without sharing credentials. For backward compatibility, unprefixed `add`, `edit`, `remove`, `list`, `order` and alias selection manage Codex.

`remove <alias>` deletes the selected client’s saved provider and API key. If it was active, the first remaining provider becomes active; deleting the final entry leaves no selection. An isolated account directory is deleted only when it is owned by easy-switch, is not a symlink and is not shared by another provider; external Codex/Claude credentials and conversation files remain in place. Deleting the last Claude provider also restores its original CLI settings. Removing a provider does not revoke its remote API key or cancel an already accepted request.

## API providers

`switch codex add api <alias>` supports OpenAI's official API and third-party Responses-compatible endpoints. Leave Base URL blank to use `https://api.openai.com/v1`, then enter your OpenAI API key. For another provider, enter its Base URL (without `/responses`) and its corresponding key. The resolved URL is saved with the alias and shown by `switch list`. New API entries inherit the request model selected in Codex; setup does not ask for a model override. Text model and effort values come from the client; old easy-switch override fields are ignored.

Edit a saved provider with `switch codex edit <alias>` or the desktop pencil button. A blank replacement key preserves the existing secret. Renaming keeps its priority, active route and account credential directory; changing an address/key takes effect on subsequent requests. Claude Code uses separate providers and commands prefixed with `switch claude`; see the [Claude Code guide](claude-code.md).

## Provider model lookup

Use the magnifying glass on any desktop provider row to read that provider’s own model catalog. Querying an inactive provider does not select it. The dialog supports editable model IDs and display names, search, fetch, add/delete, drag or keyboard ordering, model count and read time. Changes are saved together, Cancel discards the draft and Use automatic catalog restores provider discovery; failures and empty results are explicit. It never substitutes another provider’s catalog or sends a generation request to test access.

For Codex APIs, discovery uses the configured `/models` endpoint and that provider’s key. Subscriptions read the live Codex `/models?client_version=...` catalog using that account’s token and account ID. Failed discovery never substitutes the client’s bundled list. No thread is started or resumed. Catalog membership alone does not establish model access, Responses compatibility or tool support.

Select models and reasoning effort in Codex or Claude Code itself. easy-switch does not apply global or per-session text model overrides, including fields saved by older versions, and does not enumerate running tasks. Claude APIs can define a provider-specific naming map for the main model and subagents; see the [Claude Code guide](claude-code.md). If a provider does not expose discovery, consult its documentation for exact IDs.

Codex loads the deduplicated union of all configured provider catalogs through `model_providers.easy_switch.model_catalog_url`, retaining native subscription metadata and exact upstream IDs. Available IDs come only from live provider lists or explicit user entries: there is no fixed or fallback default model set. For exact matching IDs, missing effort/ordering/context-window metadata is read from sanitized metadata extracted from the pinned official helper at build time; CLI installs can use an isolated official Codex helper without credentials, threads or upstream inference; live subscription metadata takes precedence, including explicit empty effort choices. Reference metadata only enriches exact upstream IDs and never adds available models. GPT models are grouped by version series descending (`6.1`, then `6`, then `5.6`); each series retains native variant order. Other models follow in natural name order. Image-only IDs (`gpt-image-*`, `chatgpt-image-*`, `dall-e-*`), image-only output metadata and hidden native entries are excluded from the conversation picker. Image tool routes remain separate. Unknown models do not inherit invented effort options. Provider priority controls routing rather than menu order. A fresh provider catalog that excludes a model is skipped; discovery failure leaves support unknown so inference can still be attempted. Catalogs are fetched on demand and cached for one minute, scoped to credentials and provider edits, with no polling. Last observed model metadata is also stored locally with hashed provider/credential fingerprints and reused for up to 24 hours on later launches while refreshing in the background. Stale availability never blocks inference. Restart Codex/reload the editor after upgrading to enable discovery. Existing `model` preferences are preserved, and an effective user `model_catalog_json` override takes precedence; remove that override yourself if you want the remote union. API keys do not guarantee Responses/tool support.

For Codex, explicit model-access errors (`model_not_found`, `model_not_supported`, access-denial codes or clear English/Chinese messages) in HTTP 400/403/404/422 or startup SSE can try another provider before any output is accepted. The same model and complete history are retained. This request-specific fallback does not change the preferred provider: for example, Free can handle its supported models while an API handles another model. Access rejections are cached only for the provider/model pair for 60 seconds, with at most 256 entries; manual selection clears the cache. Quota cooldowns remain separate. Safety refusals and unrelated parameter errors do not qualify for model-specific fallback. A generic provider HTTP 403 uses ordinary provider failover instead. A native client that blocks the model before sending the request cannot be handled by the proxy.

## Image generation routing

Native Codex `image_gen` generation/edit calls use separate image endpoints rather than the ordinary text request. easy-switch forwards `/v1/images/generations` and `/v1/images/edits`, preserving JSON or multipart bodies, image model parameters and reference-image bytes. When subscription accounts are configured, usable subscriptions are selected first, followed by configured APIs after eligible rejections, in priority order; the text provider, client-selected text model and global failover selection remain unchanged. Image-only cooldowns are separate from text cooldowns. Native image request originator, User-Agent, image-turn ID and turn metadata are preserved, while credentials are replaced with the selected image provider’s own credentials. Successful and failed image responses identify the actual image alias and preserve the upstream image request ID. An exhausted rejection reports the attempted image providers; it does not imply the selected text API received the image request. Cached plan claims and an unexpired token do not establish live image entitlement. Without subscriptions, image requests go to the selected API and eligible API alternatives. Policy refusals and ordinary validation errors are not bypassed.

The official Codex pricing page states that Free has no Codex image generation. Free accounts are still allowed to reach the image endpoint so live authorization remains authoritative, but tool registration alone cannot grant access. No plan name is used as an image entitlement check. For JSON requests rejected by an account’s `/backend-api/codex/images/generations` or `/edits` endpoint with an eligible HTTP endpoint/entitlement error, easy-switch also tries `/backend-api/wham/images/generations` or `/edits` with the same saved OAuth token and unchanged image body. This desktop image route needs no browser session. It is not attempted for quota, authentication, policy, ordinary validation or uncertain transport failures. Paid-account generation, editing and real Codex continuation have been verified; Free authorization on this route has not. Desktop can additionally use the same saved account in the hidden Images page after explicit endpoint/entitlement rejection; eligible failures can continue through the remaining saved image providers. Once a page job is submitted, an uncertain failure cannot start a duplicate on another provider. Explicit startup SSE rejections continue through the existing provider fallback. See [verification notes](image-endpoints.md).

Desktop activation enables `features.image_generation` with authenticated local actor routing. The provider always keeps `requires_openai_auth=false` and an explicit local bearer token. While image tools are configured, `cli_auth_credentials_store="ephemeral"` and `forced_login_method="api"` keep Codex on the local gateway identity without loading a native subscription’s cached plan or quota gate. The actor header is used only between Codex and easy-switch and never forwarded to an upstream. This requires a native client supporting actor-auth image tools (tested with Codex 0.165.0). Native auth files and OS keychain credentials are left untouched; subscription credentials remain in easy-switch’s account store. The original credential-store selection, login-method restriction and tool settings are restored on stop, exit or recovery. Recovery also restores temporary sign-ins left by earlier releases. Adding a subscription or API while routing is running performs the same tool setup; API-only users do not need any extra sign-in or image preference to expose native image tools. **Reload an already-open Codex client once after setup or upgrading to 0.5.24**: a proxy cannot retroactively add tools to its existing client tool registry. Subsequent provider switches keep the tool available. The Linux CLI installer retains its existing API-mode configuration. Requests sent directly to other endpoints, shell scripts or external image servers do not pass through this routing.

Built-in images use subscription quota and remain subject to that account’s limits and permissions. The native protocol is covered by real Codex tests using isolated API, native-subscription and Free-account homes with local simulated image responses. These tests establish tool registration and routing, not live account entitlement. See [official Codex image generation](https://learn.chatgpt.com/docs/image-generation).

Codex 0.165.0 excludes a native Free sign-in from image-tool registration before it considers actor-auth routing. The ephemeral gateway identity avoids loading that account-level client gate without changing any account’s plan claims or the official image service’s authorization. Real credentials are then tried through the image route. Image access in ChatGPT’s web interface does not establish access to the Codex image endpoint. The integrated ChatGPT image page and Codex’s image tool have distinct request paths; the official desktop bridge can attach the existing account token to ChatGPT backend requests. Desktop automatically uses a temporary hidden ChatGPT Images session with the saved account token after that account’s direct endpoints are explicitly unavailable. It needs no separate login or preference, preserves the genuine account plan, and releases its browser state after each job; see [automatic account images](account-images.md).

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

Uninstall restores the original configuration, removes the service, saved account copies, caches, generated completions and the current-user package and private runtime after confirmation. `switch uninstall` is the preferred command; `--yes` supports unattended cleanup. If configuration changed after installation, restoration stops rather than discarding your changes. The original text is in `installation.json`; merge it manually when necessary. Original client credentials and conversations, and the shared systemd linger setting, are preserved.

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
- Supports HTTP SSE at `POST /v1/responses`, plus JSON/multipart image generation and edits at `POST /v1/images/generations` and `POST /v1/images/edits`. Serves the native Codex catalog at authenticated `GET /v1/models`. Also accepts `POST /v1/responses/compact` and older Responses `compaction_trigger` requests, generating readable summaries via the normal Responses route and wrapping them in authenticated local checkpoints. Does not proxy WebSockets or convert Chat Completions.
- Replays ordinary messages and complete tool calls/results. Removes `reasoning` items, so hidden reasoning continuity and cache efficiency may differ from direct use.
- Rejects `previous_response_id` and server-side conversations without full history. Matching inline item references are expanded once; unresolved upstream references and existing encrypted compaction items are preserved and can try compatible fallback providers. Future Codex compaction is explicitly configured as local readable summaries (`capabilities.remote_compaction="unsupported"` means use Codex local compaction, not disable compaction). Model catalogs preserve official context windows and provider-supplied compression thresholds, enabling automatic compaction. Local checkpoints survive proxy restarts and upstream switches while the same state token is retained. Opaque checkpoints made by another upstream cannot be decrypted locally; if every provider rejects them, history is retained and an explicit error is returned instead of silently dropping it.
- The model ID is preserved across providers. Display names only label catalog entries; they do not change protocol, image, tool, reasoning or context capabilities.
- Request bodies are limited to 32 MiB. Raw upstream error bodies are not echoed. Authentication challenges are generated locally from the official device flow.
- No mid-response migration. Only eligible upstream rejections are retried through available alternatives before output or tool events are accepted. Startup SSE capacity errors can also be intercepted within a bounded 64 KiB preamble. Client disconnection cancels transport but does not guarantee upstream billing stops.

Real-Codex/mock-upstream tests verify configuration loading and same-thread switching. Real-provider authentication, the VS Code Remote UI, and actual server reboot recovery remain unverified end to end.


## Automatic failover

HTTP 401, 402, 403 and 429 rejections are eligible for immediate failover before output. Subscription `usage_limit_reached`, API `insufficient_quota` and explicit credit/balance errors are also recognized in HTTP 200 startup SSE and HTTP 400/422 errors. A successful backup hides the rejected startup events; it does not falsify the exhausted account’s quota in the app. Generic provider 403 errors, including HTML/empty responses and startup SSE permission errors, can try an available backup. Explicit content-safety, regional or organization-policy restrictions are preserved. Exhausted HTTP errors report the attempted aliases without exposing raw upstream error bodies.

For Codex text/compaction and Claude Messages/token-counting requests, transient HTTP 500/502/503/504/529, connection failures and model-capacity rejections are returned to the client for its native retry handling. This includes `server_overloaded`, “Selected model is at capacity” and startup SSE errors before output is accepted. easy-switch adds no retry loop, delay schedule or retry-limit configuration. It does not cool down or automatically switch providers for these transient failures, even after repeated client requests. Retry-After is passed through unchanged. When the client exhausts its own retry budget, the request ends with its error rather than starting another sequence on a backup. The actual native retry limit depends on the client version and its configuration. Explicit quota, authentication and model-access rejections still use eligible failover. Manual changes apply to the next client request, including a native retry, and disconnection cancels transport. The selected model/effort and replayable tool results are retained. No output, tool call, unknown SSE event, or already-ended turn is replayed or automatically restarted. Image submissions keep their separate routing policy. Other parameter errors are returned; the client can independently retry.

Candidates must have configured API credentials or a readable, unexpired subscription credential cache. Candidates follow `switch order`, highest priority first, regardless of type. Run `switch list` to view numbered priorities and the active alias (`*`). Run `switch order` in an interactive terminal: ↑/↓ selects, Shift+↑/↓ or uppercase K/J moves, Enter saves, and Esc or Ctrl+C cancels. Noninteractive callers can use `switch order <alias> ...` with every configured alias exactly once. Defaults and legacy states use addition order; new aliases are appended. Reordering preserves the active alias and cooldowns, and applies to new requests without restarting the service. In-flight requests retain their ordering snapshot. This local check does not guarantee upstream acceptance. Failed providers are excluded from fallback selection for 60 seconds within the running proxy process. Restarting the service clears cooldowns. Explicit manual selection resets cooldowns on the next request and can select a cooling-down provider.

Selection is persisted before the alternate request, so subsequent requests use that alias even if the alternate fails. A generation check prevents an old failure from overwriting a newer selection. Retries stop on success, an ineligible error, or queue exhaustion. If the active selection changes while a rejected request is pending, that request can continue on the newly selected, untried alias without overwriting the selection. The failover attempt budget is bounded by the provider count; transient failures stop that request’s fallback loop. The state file records the last failover's aliases, HTTP status, and timestamp.

Local missing/expired subscription credentials and upstream account HTTP 401 first attempt eligible failover; if none succeeds in selecting an alternate, it starts device authentication. Authentication completion itself does not retry a request.

Full replayable conversation input and tool results are sent to the alternative. Hidden reasoning and upstream response references cannot be transferred. This implementation keeps the existing multi-account device-login workflow and background service; it does not copy the source server's Codex launcher or native OAuth forwarding design.

## CLI comparison with CC Switch

CC Switch’s desktop repository points terminal users to the separately maintained [CC Switch CLI](https://github.com/SaladDay/cc-switch-cli), whose [documented commands](https://github.com/SaladDay/cc-switch-cli/blob/main/README.md) include:

| Action | easy-switch | CC Switch community CLI |
| --- | --- | --- |
| Keyboard menu | `switch` | `cc-switch` |
| Add a provider interactively | `switch add` | `cc-switch` (TUI; v5.11.4 `provider add` is noninteractive) |
| List Codex providers | `switch list` | `cc-switch --app codex provider list` |
| Switch Codex | `switch <alias>` | `cc-switch --app codex use <id>` |
| List Claude providers | `switch claude list` | `cc-switch --app claude provider list` |
| Switch Claude | `switch claude <alias>` | `cc-switch --app claude use <id>` |
| Remove a Codex provider | `switch remove <alias>` | `cc-switch --app codex provider delete <id>` |

The community CLI defaults to Claude, while unprefixed easy-switch commands keep Codex as their default. The interactive menu makes the client choice explicit. These are command comparisons, not a claim that the projects share routing or storage implementations.

The complete verified command tree for CC Switch CLI 5.11.4 is available in the [command reference](cc-switch-cli.md).

## Selected task sync

Run `switch sync setup` to verify WebDAV or the included self-hosted server, then `switch sync list` and `switch sync add <task-id>`. On each destination, use `switch sync project <project-key> /absolute/project/root` once. The existing current-user service synchronizes completed Codex turns and Git state automatically; credentials and provider settings stay local. `switch sync remove <task-id>` disables that device’s selection without deleting the conversation. Conflicting versions require an explicit `switch sync resolve <task-id> local|remote` choice. See [task-sync.md](task-sync.md) for deployment, encryption, limits and the distinction between saved conversations and live processes.
