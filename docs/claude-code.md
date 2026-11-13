# Claude CLI and Desktop / Claude 接入

[English README](../README.md) · [简体中文 README](README.zh-CN.md)

## English

Select **Claude** at the top of the desktop window. Its providers and fallback order are independent of Codex. Claude Code CLI and Claude Desktop share this Claude provider list, selected provider, credentials and fallback order; all clients can run at once. Changing the selector only chooses which list you are editing.

**Client configuration:** the CLI adapter writes user-level `settings.json`; the Desktop adapter separately writes its [third-party inference profile](https://code.claude.com/docs/en/llm-gateway-connect#desktop-app). Start Claude Desktop once to create its configuration directory. With at least one Claude provider, the easy-switch desktop app detects that directory and registers a profile pointing to `http://127.0.0.1:18345/claude-desktop`. Fully quit and reopen Desktop after routing starts or stops; minimizing its window is insufficient. The Linux systemd CLI setup continues to configure only Claude Code CLI.

Desktop and CLI discover the deduplicated union of all configured Claude providers’ catalogs under one easy-switch gateway. If a subscription offers Fable, Opus and Haiku and an API offers three DeepSeek models, the catalog contains all six. Non-Claude models have stable internal Claude-compatible route IDs and their real display names; the gateway forwards their actual upstream IDs. CLI needs these internal IDs too: it filters discovery entries without `claude` or `anthropic`. easy-switch enables gateway discovery in CLI user settings and restores that setting when routing stops. Existing built-in menu entries and managed policy restrictions still apply. Fully restart both clients after upgrading to refresh discovery.

Each provider catalog is cached for one minute without polling. Partial discovery failures keep previously observed models while other providers remain usable; removing a provider removes its entries. Saved mapping targets are included when model discovery is unavailable. Individual magnifying-glass queries still inspect only that provider. The local profile ID, endpoint and token stay unchanged across upstream switches. Mappings do not grant model access or supply missing protocol features; this gateway cannot convert hosted cloud conversations or Remote Control sessions.

Desktop settings live under `~/Library/Application Support/Claude` and `Claude-3p` on macOS; `%LOCALAPPDATA%/Claude` and `Claude-3p` on Windows, including detected directory variants; and `$XDG_CONFIG_HOME/Claude` and `Claude-3p` on Linux (`~/.config` by default). easy-switch manages `deploymentMode` in the two `claude_desktop_config.json` files and its own `configLibrary` profile/registration. It records original values before writing, restores them on stop/quit/crash, and preserves unrelated settings, MCP servers, other profiles and concurrent edits. Real upstream keys remain in easy-switch; the Desktop profile contains only the local token. Tests isolate paths with `SWITCH_CLAUDE_DESKTOP_HOME`. Gateway requests, failover and recovery are covered with mock upstreams and real easy-switch Electron tests. A live DeepSeek provider passed minimal Messages, streaming, adaptive thinking and tool-call probes through the proxy; this does not establish full Claude Desktop end-to-end or every agent feature compatibility.

Select the real DeepSeek name in Desktop or CLI’s `/model` menu to use that model directly. If a client retains only its official menu, or you prefer official names, edit the API provider’s **Claude model mapping** and assign a different upstream ID to each family. The provider must support Anthropic Messages, streaming and tools; OpenAI Chat/Responses-to-Messages conversion is not included.

**API:** choose **Add API provider**. An empty Base URL means `https://api.anthropic.com`. Other providers must implement Anthropic Messages and accept Bearer or `x-api-key` authentication; an OpenAI-compatible address alone is insufficient. Enter the provider’s base address without `/v1/messages`; an existing `/v1` suffix is accepted.

**Subscription:** install the [official Claude Code CLI](https://code.claude.com/docs/en/setup), then choose **Add subscription**. easy-switch runs `claude auth login --claudeai` with an isolated `CLAUDE_CONFIG_DIR`. Open the official browser sign-in and paste its authorization code into the dialog when prompted. On macOS, allow the official client to save its isolated login and easy-switch to read it from Keychain. On Linux/Windows the official client uses its credential file. The app copies OAuth credentials into its protected account directory, refreshes expiring access tokens, and starts a new official sign-in when required. It does not replace the normal client’s saved subscription login. Use **Import existing sign-in** to copy an existing API configuration or subscription instead.

Claude Code must be installed separately; it is not redistributed in easy-switch’s MIT package. If it is outside the usual installation locations, set `SWITCH_CLAUDE_BIN` to its executable. Subscription sign-in requires a current CLI with `claude auth login` support.

After adding your first provider, reopen Claude Code once. While easy-switch runs, the user-level `settings.json` points `ANTHROPIC_BASE_URL` at `http://127.0.0.1:18345/claude` and uses a local routing token. The proxy replaces it with only the selected upstream’s credential. Quitting restores the previous connection values and retains unrelated settings or concurrent user edits. A recovery helper also restores settings after an application crash. Explicit command-line, project, managed, extension or cloud-provider settings can take precedence; check these if traffic does not reach the local proxy.

Linux uses the existing easy-switch systemd service:

```bash
switch claude add api relay
switch claude add account personal
switch claude list
switch claude relay
switch claude order
switch claude edit relay
```

The first `add` connects Claude Code to the running local service. Repeating `switch claude add account <existing-alias>` renews that subscription without adding a duplicate. A browser authorization code can be pasted into the SSH terminal. Service uninstall restores Claude settings alongside Codex settings. The Linux installer retains its documented systemd and Codex CLI prerequisites.

**Model discovery:** click the magnifying glass on any Claude provider row, including inactive rows. Discovery reads that provider’s `/v1/models`, with pagination. On HTTP 404/405 for API entries, it also tries same-host `/models` variants, including stripping a terminal `/anthropic`. It never falls back to another provider’s catalog, sends generation requests to test access or changes the selected route. Missing discovery support is shown as an error.

**Family model mapping:** each API can independently map Fable, Opus, Sonnet and Haiku. Click its magnifying glass and use **Map to Fable**, **Map to Opus**, etc., or enter exact IDs in the edit dialog. CLI `switch claude add api` and `switch claude edit` offer the same fields; blank input preserves an existing value and `-` clears it. No mapping is inferred from model position or name.

| Client selection | Example API mapping | Subscription request |
| --- | --- | --- |
| Fable | `deepseek-v4-pro` | Original Claude Fable ID |
| Opus | `deepseek-v4-1-flash` | Original Claude Opus ID |
| Haiku | `deepseek-v4-flash` | Original Claude Haiku ID |

These are examples, not preset rules. A configured family mapping takes priority over legacy main/subagent defaults, including agent requests. Blank families retain the original model unless a legacy fallback is configured. Subscription accounts never use API mappings. Existing main/subagent defaults remain available in a collapsed section for older configurations; a legacy main model is still exposed as one custom CLI option.

**Retry behavior depends on the selection:** a DeepSeek menu entry or explicit non-Claude ID keeps that exact model on every attempt; providers that cannot serve it are skipped. A Claude family selection, including a full Claude family ID, is resolved separately for each provider: Fable can use your API’s mapped DeepSeek Pro, then the original official Fable ID on a subscription after a retryable rejection. Another API applies its own Fable mapping. This makes cross-model fallback an explicit user configuration. Histories, tools and thinking signatures remain unchanged, so protocol and context compatibility can still limit a cross-model continuation. Model menu changes require restarting the client; editing gateway mappings applies to subsequent requests immediately.

**Switching:** the next Messages request reads the current provider, including tool-result continuations. HTTP quota/authentication/model-access rejections, transient connection/server failures and startup SSE errors can try alternatives before output is accepted. Only a successful fallback becomes active. Quota/model cooldowns are scoped to provider and model; authentication failures cool down that provider. If no route succeeds, errors retain all attempts. Desktop upstream 401/402 failures are returned as gateway 502 errors with their original statuses in the details; invalid local tokens still receive 401, preventing upstream failures from falsely invalidating the local credential. Anthropic version/beta headers, message history, tools and response rate-limit headers are preserved. Accepted output/tool calls are never replayed. Incompatible model IDs, thinking signatures, context sizes or tools can still cause failures across providers. This is routing within one client; Codex conversations are not converted into Claude Code conversations. Claude subscription quota rings and Codex image borrowing are not included. There is no task-list or per-session model-selection UI.

**DeepSeek:** official documentation now provides [Responses for Codex](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/) with base `https://api.deepseek.com`, and [Anthropic compatibility for Claude Code](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/) with base `https://api.deepseek.com/anthropic`. Use a currently available DeepSeek model ID. A third-party reseller must separately confirm it exposes these protocols.

Official references: [authentication](https://code.claude.com/docs/en/authentication), [gateway connection](https://code.claude.com/docs/en/llm-gateway-connect), [gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol), [model configuration](https://code.claude.com/docs/en/model-config), [subagents](https://code.claude.com/docs/en/sub-agents). Anthropic does not guarantee compatibility with non-Claude models; DeepSeek documents and maintains its own compatibility layer.

## 简体中文

在桌面顶部选择 **Claude**，即可管理独立于 Codex 的服务商和备用顺序。Claude Code CLI 与 Claude Desktop 共用这套服务商、当前选择、凭据与备用顺序，所有客户端可以同时运行；顶部选择器只决定正在编辑哪份列表。

**客户端配置：**CLI 适配器写入用户级 `settings.json`；Desktop 适配器独立写入[第三方推理 profile](https://code.claude.com/docs/en/llm-gateway-connect#desktop-app)。先打开 Claude Desktop 一次以创建配置目录。添加至少一个 Claude 服务商后，easy-switch 桌面应用会检测该目录，注册指向 `http://127.0.0.1:18345/claude-desktop` 的 profile。路由启停后需完全退出并重新打开 Desktop，仅最小化窗口不会重新加载配置。Linux systemd 命令行安装仍只自动配置 Claude Code CLI。

Desktop 和 CLI 在固定 easy-switch 网关下发现所有已配置 Claude 服务商模型目录的去重并集。订阅提供 Fable、Opus、Haiku，API 提供三个 DeepSeek 模型时，目录包含这六个模型。非 Claude 模型使用稳定的内部兼容路由 ID，菜单显示真实模型名称，转发时还原为上游实际 ID。CLI 同样需要兼容 ID，因为它会过滤不含 `claude`／`anthropic` 的模型。easy-switch 会在 CLI 用户设置中启用模型发现，停止路由后恢复。客户端原有内置条目及托管策略限制仍然生效；升级后请完全重启两个客户端以刷新目录。

各服务商目录缓存一分钟，不增加后台轮询。部分查询失败时保留曾读取的模型，其他服务商仍可使用；删除服务商会移除对应目录。目录不可查询时，用户保存的映射目标仍可加入。放大镜始终只查询对应条目。本地 profile、地址、令牌在上游切换期间不变。模型映射不增加访问权限或工具能力，也不能转换官方托管会话与 Remote Control 会话。

macOS 配置位于 `~/Library/Application Support/Claude` 与 `Claude-3p`；Windows 位于 `%LOCALAPPDATA%/Claude` 与 `Claude-3p`，兼容检测到的目录变体；Linux 位于 `$XDG_CONFIG_HOME/Claude` 与 `Claude-3p`，默认使用 `~/.config`。easy-switch 管理两个 `claude_desktop_config.json` 中的 `deploymentMode` 及自己的 `configLibrary` profile 与注册信息，写入前记录原值。停止、退出及异常崩溃会恢复原配置，保留其他设置、MCP、其他 profile 和用户并发修改。真实上游密钥留在 easy-switch，Desktop profile 仅保存本地令牌。测试通过 `SWITCH_CLAUDE_DESKTOP_HOME` 隔离目录；网关请求、故障转移及恢复已由模拟上游和真实 easy-switch Electron 测试覆盖；真实 DeepSeek 上游已通过代理完成最小 Messages、流式响应、自适应推理及工具调用探测，尚不能等同于 Claude Desktop 全流程或全部 agent 功能验证。

使用 DeepSeek 真实名称条目时，直接在 Desktop 或 CLI 的 `/model` 菜单选择。客户端仅保留官方菜单，或你偏好官方名称时，在 API 条目的 **Claude 模型映射** 中为各系列独立设置目标。上游需支持 Anthropic Messages、流式响应及工具调用；不包含 OpenAI Chat／Responses 到 Messages 的协议转换。

**API：**点击**添加 API 服务商**。Base URL 留空使用 `https://api.anthropic.com`。第三方必须支持 Anthropic Messages 协议及 Bearer 或 `x-api-key` 认证，仅支持 OpenAI 协议的地址不能直接使用。填写地址时不附加 `/v1/messages`；已有 `/v1` 后缀也可识别。

**订阅：**先安装[官方 Claude Code](https://code.claude.com/docs/en/setup)，再点击**添加订阅**。软件通过隔离的 `CLAUDE_CONFIG_DIR` 运行官方 `claude auth login --claudeai`，在浏览器完成认证，并按提示将授权码粘贴到对话框。macOS 可能请求官方客户端写入、easy-switch 读取隔离登录的钥匙串权限；Linux/Windows 使用官方凭据文件。OAuth 凭据随后复制到受权限保护的账号目录，访问令牌临近过期时刷新，必要时重新启动官方认证。本机正常客户端的订阅登录不会被替换。也可通过**导入现有登录方式**复制本机已有的 API 配置或订阅。

Claude Code 需单独安装，不包含在 easy-switch 的 MIT 分发包中。非标准安装位置可使用 `SWITCH_CLAUDE_BIN` 指定可执行文件。订阅认证需要支持 `claude auth login` 的当前版本。

添加首个服务商后，重新打开 Claude Code 一次。运行期间，用户级 `settings.json` 将请求指向 `http://127.0.0.1:18345/claude`，并使用仅供本地路由的令牌；代理只向上游发送当前选中的凭据。退出后恢复原连接配置，保留其他设置和用户并发修改；异常退出也由恢复助手处理。命令行、项目、托管策略、扩展或云服务配置可能覆盖用户级设置，流量未经过本地代理时请检查这些来源。

Linux 复用现有 systemd 服务，上面的命令示例同样适用。首次 `add` 后写入 Claude 路由；重复执行 `switch claude add account <已有别名>` 可以重新认证，不创建重复条目。SSH 终端中可粘贴浏览器返回的授权码。卸载服务时同时恢复 Codex 和 Claude 配置；Linux 安装器仍需满足既有 systemd、Codex CLI 等前提。

**模型查询：**点击任意 Claude 服务商行的放大镜，读取该条目自身的 `/v1/models`，支持分页，未选中的条目也可查询。API 查询返回 404/405 时，可继续尝试同主机的 `/models` 及去掉末尾 `/anthropic` 的地址。查询不改变路由，不发送推理请求，也不使用其他服务商目录替代；不支持查询时明确显示错误。

**按系列映射：**每个 API 可独立配置 Fable、Opus、Sonnet、Haiku。点击放大镜中的**映射到 Fable**、**映射到 Opus**等按钮，或在编辑框直接填写真实模型 ID。`switch claude add api` 和 `switch claude edit` 提供相同字段；留空保留已有值，`-` 清除。软件不会按模型顺序或名称擅自推断映射。

| 客户端选择 | API 映射示例 | 订阅实际请求 |
| --- | --- | --- |
| Fable | `deepseek-v4-pro` | 原始 Claude Fable ID |
| Opus | `deepseek-v4-1-flash` | 原始 Claude Opus ID |
| Haiku | `deepseek-v4-flash` | 原始 Claude Haiku ID |

以上是示例，由用户自行选择。系列映射优先于旧版主模型／子代理默认值，也适用于 agent 请求。某系列留空则保留原模型，配置了旧版默认回退时除外。订阅账号不应用 API 映射。旧版主模型／子代理配置保留在折叠区；旧版主映射仍可作为 CLI 的一个自定义条目。

**备用重试取决于你的选择：**选 DeepSeek 真实名称或明确指定非 Claude ID 时，各次重试保持同一模型，跳过不提供它的服务商。选 Claude 系列（含完整 Claude 系列 ID）时，每个服务商分别解析：例如 Fable 在 API 使用你配置的 DeepSeek Pro，遇到可重试拒绝后，备用订阅使用原始官方 Fable ID；另一个 API 则应用它自己的 Fable 映射。因此，跨模型重试来自用户明确设置。历史、工具和思考签名保留，跨模型兼容性仍可能限制续接。模型菜单更新需要重启客户端；网关映射修改对后续请求立即生效。

后续 Messages 请求读取新路由，包括工具结果续接。额度、认证、模型访问拒绝、暂时的连接或服务器故障、启动 SSE 错误可在接受输出前尝试备用服务。仅成功的备用服务商会变为当前选择；额度、模型冷却按服务商和模型隔离，认证失败按服务商冷却。无路由成功时保留所有尝试；Desktop 上游 401/402 转为网关 502，详情保留原始状态，本地令牌无效才返回 401，避免客户端误判本地密钥失效。版本、beta 请求头、消息历史、工具定义和额度响应头保留。已接受的输出及工具调用不会重放。模型名称、思考签名、上下文长度和工具不兼容仍可能导致失败。此功能不在两个客户端之间转换会话。首批适配不包含 Claude 订阅额度圈、Codex 图片借用；不提供任务列表或按会话选择模型的界面。

**DeepSeek：**目前官方已分别提供 Codex Responses 地址 `https://api.deepseek.com` 和 Claude Code Anthropic 兼容地址 `https://api.deepseek.com/anthropic`，需选择其实际提供的模型。第三方中转商是否暴露这两种协议，应向该服务商确认。Claude 官方不保证非 Claude 模型的兼容性，DeepSeek 的适配由其自身维护。

**Session scope / 会话范围：** Existing sessions already connected to the easy-switch gateway keep the same connection while upstreams change. Restart Desktop once after initial setup to load the gateway; a proxy cannot redirect requests from a process still connected directly to another endpoint or convert hosted conversations into local gateway sessions. / 已接入 easy-switch 网关的现有会话在切换上游时维持相同连接。首次接入后完全重启 Desktop 一次；代理无法改道仍直连其他地址的旧进程，也不能把官方托管会话转换为本地网关会话。

**Gateway errors / 网关报错：**`Gateway returned an error` means the inference test was rejected. The proxy reports the attempted upstream model and a bounded, credential-redacted error message. `Folder not found` is a separate local working-directory issue; choose an existing folder in Desktop. / 前者表示推理测试被拒绝，代理返回实际尝试模型与脱敏后的有限错误信息；后者属于本地工作目录问题，需要在 Desktop 重新选择存在的文件夹。


## Implementation references / 实现参考

[CC Switch’s model mapper](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/proxy/model_mapper.rs) and [Desktop guide](https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/2-providers/2.6-claude-desktop.md) implement family-specific model routes. [Claude Code Router](https://github.com/musistudio/claude-code-router) also routes models by purpose. easy-switch implements its own JavaScript family mapping, shared by CLI and Desktop, while retaining direct real-name catalog selection. See Claude Code’s [gateway discovery protocol](https://code.claude.com/docs/en/llm-gateway-protocol#model-discovery) for the CLI model-ID filter and discovery settings. / CC Switch 已实现按模型系列映射，Claude Code Router 则提供按用途路由。easy-switch 使用自己的 JavaScript 实现，让 CLI 与 Desktop 共用系列规则，同时保留真实模型名称选择。CLI 的 ID 过滤与发现开关见官方协议。
