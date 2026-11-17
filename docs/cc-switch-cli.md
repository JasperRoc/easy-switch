# CC Switch CLI command reference (v5.11.4)

Verified against the official macOS arm64 release binary with recursive `--help` calls. Source: [SaladDay/cc-switch-cli v5.11.4](https://github.com/SaladDay/cc-switch-cli/releases/tag/v5.11.4). This is the separately maintained community CLI, not the desktop executable.

Run `cc-switch` for the interactive UI; `cc-switch interactive` (alias `ui`) is explicit. The default app is Claude. Set `-a <app>` or `--app <app>` for another client. The release binary accepts `claude`, `codex`, `gemini`, `open-code`, `hermes`, `open-claw`, and `pi`.

## Commands

Each row lists the valid immediate subcommands. Append `--help` to see arguments and options for any complete command. `help`, `-h` and `--help` are available throughout.

| Command prefix | Subcommands |
| --- | --- |
| `cc-switch` | `auth`, `provider`, `use`, `mcp`, `prompts`, `skills`, `config`, `proxy`, `settings`, `failover`, `sessions`, `hermes`, `start`, `daemon`, `env`, `deeplink`, `update`, `interactive`, `completions` |
| `cc-switch auth` | `status`, `list`, `login`, `default`, `remove`, `logout`, `reset-quota` |
| `cc-switch provider` | `list`, `current`, `switch`, `add`, `edit`, `delete`, `duplicate`, `import-live`, `remove-from-config`, `set-default`, `speedtest`, `stream-check`, `fetch-models`, `quota`, `usage-query`, `export` |
| `cc-switch mcp` | `list`, `add`, `edit`, `delete`, `enable`, `disable`, `set-apps`, `validate`, `sync`, `import` |
| `cc-switch prompts` | `list`, `current`, `live`, `import`, `activate`, `deactivate`, `create`, `edit`, `rename`, `delete`, `show`, `system`, `templates` |
| `cc-switch skills` | `list`, `discover`, `market`, `install`, `check-updates`, `update`, `uninstall`, `enable`, `disable`, `set-apps`, `sync`, `scan-unmanaged`, `import-from-apps`, `info`, `sync-method`, `storage-location`, `repos` |
| `cc-switch config` | `show`, `path`, `export`, `import`, `backup`, `restore`, `validate`, `reset`, `common`, `openclaw`, `webdav`, `s3` |
| `cc-switch proxy` | `show`, `enable`, `disable`, `config`, `serve` |
| `cc-switch settings` | `show`, `language`, `visible-apps`, `claude-onboarding`, `claude-plugin`, `codex-auth-preservation`, `codex-history`, `outbound-proxy` |
| `cc-switch failover` | `show`, `enable`, `disable`, `list`, `available`, `add`, `remove`, `move`, `clear` |
| `cc-switch sessions` | `list`, `show`, `messages`, `resume`, `delete`, `search`, `sync-usage` |
| `cc-switch hermes` | `memory` |
| `cc-switch start` | `claude`, `codex` |
| `cc-switch daemon` | `start`, `stop`, `status`, `logs` |
| `cc-switch env` | `check`, `list`, `tools` |
| `cc-switch completions` | `install`, `status`, `uninstall` |
| `cc-switch provider usage-query` | `show`, `set`, `clear` |
| `cc-switch prompts system` | `show`, `edit`, `delete` |
| `cc-switch prompts templates` | `list`, `show`, `create`, `edit`, `delete` |
| `cc-switch skills repos` | `list`, `add`, `remove`, `enable`, `disable` |
| `cc-switch config common` | `show`, `format`, `extract`, `set`, `clear` |
| `cc-switch config openclaw` | `path`, `health`, `dir`, `env`, `tools`, `agents`, `workspace`, `memory` |
| `cc-switch config webdav` | `show`, `set`, `clear`, `jianguoyun`, `check-connection`, `upload`, `download`, `migrate-v1-to-v2` |
| `cc-switch config s3` | `show`, `set`, `clear`, `check-connection`, `upload`, `download` |
| `cc-switch settings visible-apps` | `show`, `mode`, `enable`, `disable`, `set` |
| `cc-switch settings claude-onboarding` | `show`, `skip`, `require` |
| `cc-switch settings claude-plugin` | `show`, `enable`, `disable` |
| `cc-switch settings codex-auth-preservation` | `show`, `enable`, `disable` |
| `cc-switch settings codex-history` | `show`, `enable`, `disable`, `migrate-existing`, `restore` |
| `cc-switch settings outbound-proxy` | `show`, `set`, `clear` |
| `cc-switch hermes memory` | `show`, `set`, `clear`, `enable`, `disable`, `limits`, `open-dir` |
| `cc-switch config openclaw dir` | `show`, `set`, `clear` |
| `cc-switch config openclaw env` | `show`, `set`, `put`, `unset` |
| `cc-switch config openclaw tools` | `show`, `set`, `profile`, `allow`, `deny` |
| `cc-switch config openclaw agents` | `show`, `set`, `primary`, `fallback`, `runtime` |
| `cc-switch config openclaw workspace` | `list`, `exists`, `show`, `set`, `open-dir` |
| `cc-switch config openclaw memory` | `list`, `show`, `set`, `search`, `delete`, `open-dir` |
| `cc-switch config openclaw tools allow` | `list`, `add`, `remove`, `set-at`, `insert-at`, `remove-at`, `clear` |
| `cc-switch config openclaw tools deny` | `list`, `add`, `remove`, `set-at`, `insert-at`, `remove-at`, `clear` |
| `cc-switch config openclaw agents fallback` | `list`, `add`, `remove`, `set-at`, `insert-at`, `remove-at`, `clear` |
| `cc-switch config openclaw agents runtime` | `set`, `unset` |

Top-level commands without nested subcommands: `use <id>`, `deeplink <url>`, `update`, and `interactive`. Unix releases also include `start` and `daemon`; those are not compiled as command groups on Windows.

## Common actions

```bash
cc-switch                                  # Keyboard UI
cc-switch --app codex provider list         # Codex providers
cc-switch --app codex provider current      # Current Codex provider
cc-switch --app codex use <id>              # Switch Codex
cc-switch --app claude use <id>             # Switch Claude
cc-switch --app codex provider add --help   # Noninteractive add options
cc-switch --app codex provider delete <id>  # Delete provider
cc-switch auth login                       # Codex OAuth sign-in
cc-switch auth list                        # Saved OAuth accounts
cc-switch --app codex failover show        # Fallback settings
cc-switch --app codex proxy enable         # Enable daemon-managed routing (Unix)
cc-switch sessions list --all              # Saved sessions
cc-switch update --check                   # Check for updates
cc-switch completions install --activate   # Install and activate Bash/Zsh completion
```

In v5.11.4, `provider add` is noninteractive: use the TUI for interactive adding. `completions [bash|elvish|fish|powershell|zsh]` outputs a completion script; lifecycle install/status/uninstall supports Bash and Zsh. `settings language [en|zh]` reads or changes the TUI language.

## 简体中文

以上为实际下载的 **5.11.4 发布版**递归执行 `--help` 得到的命令树，不是只摘取几个 README 示例。每一行左侧是前缀，右侧是可接的子命令；参数用对应的 `--help` 查看。默认管理 Claude，管理 Codex 时加 `--app codex`。顶层 `start`、`daemon` 仅编译到 Unix 版本。

`provider add` 在此版本是非交互添加，交互添加请直接运行 `cc-switch`。已有账号认证、服务商切换、备用队列、会话、代理、补全等命令分别位于表中各自的分组。
