# Claude CLI and Desktop / Claude 接入

[English README](../README.md) · [简体中文 README](README.zh-CN.md)

## English

Select **Claude** at the top of the desktop window. Its providers and fallback order are independent of Codex. Claude Code CLI and Claude Desktop share this Claude provider list, selected provider, credentials and fallback order; all clients can run at once. Changing the selector only chooses which list you are editing.

**Client configuration:** the CLI adapter writes user-level `settings.json`; the Desktop adapter separately writes its [third-party inference profile](https://code.claude.com/docs/en/llm-gateway-connect#desktop-app). Start Claude Desktop once to create its configuration directory. With at least one Claude provider, the easy-switch desktop app detects that directory and registers a profile pointing to `http://127.0.0.1:18345/claude-desktop`. Fully quit and reopen Desktop after routing starts or stops; minimizing its window is insufficient. The Linux systemd CLI setup continues to configure only Claude Code CLI.

Desktop discovers the union of all configured Claude providers’ catalogs on demand, with a one-minute cache per provider and no background polling. Duplicate model IDs appear once. Temporary discovery failures retain previously observed IDs; an unavailable provider does not hide other providers’ models. A successful empty catalog or provider removal removes its entries. Explicit mappings are also included when discovery is unavailable. The menu displays actual model names with `easy-switch · <model ID>` descriptions. Non-Claude models use distinct, stable internal Claude-compatible route IDs so Desktop’s official catalog cannot replace their names; only real upstream IDs are forwarded. An explicit catalog selection takes priority over saved main/subagent defaults, including requests with a `[1m]` context marker or agent header. Default requests use the selected provider’s configured mapping or first catalog model. The chosen model is then fixed for that request: provider changes and retries cannot replace it with another provider’s default. Providers known not to offer it are skipped. The CLI gateway discovery endpoint returns the same union with original IDs; individual magnifying-glass queries still inspect only that provider. The local profile ID, endpoint and token stay unchanged across upstream switches, so connected sessions share one easy-switch gateway. Upgrading from 0.5.7 or earlier requires a full Desktop restart to refresh its model menu. Mappings do not grant access or expand an upstream’s tool capabilities. This implements the Desktop gateway path, not changes to account plans, hosted cloud environments or Remote Control.

Desktop settings live under `~/Library/Application Support/Claude` and `Claude-3p` on macOS; `%LOCALAPPDATA%/Claude` and `Claude-3p` on Windows, including detected directory variants; and `$XDG_CONFIG_HOME/Claude` and `Claude-3p` on Linux (`~/.config` by default). easy-switch manages `deploymentMode` in the two `claude_desktop_config.json` files and its own `configLibrary` profile/registration. It records original values before writing, restores them on stop/quit/crash, and preserves unrelated settings, MCP servers, other profiles and concurrent edits. Real upstream keys remain in easy-switch; the Desktop profile contains only the local token. Tests isolate paths with `SWITCH_CLAUDE_DESKTOP_HOME`. Gateway requests, failover and recovery are covered with mock upstreams and real easy-switch Electron tests. A live DeepSeek provider passed minimal Messages, streaming, adaptive thinking and tool-call probes through the proxy; this does not establish full Claude Desktop end-to-end or every agent feature compatibility.

To use DeepSeek, click the provider’s magnifying glass and choose **Use as main model** / **Use for subagents**. Exact IDs can also be entered in **Claude model mapping**. In the CLI, open a new `claude` session, use `/status` to confirm the local base URL and `/model` for the custom entry. In Desktop, choose the actual model name after its initial restart. The provider must support Anthropic Messages, streaming and tool calls; a model-name mapping cannot supply missing protocol capabilities. OpenAI Chat/Responses-to-Messages conversion is not included.

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

**DeepSeek model mapping:** setting a Base URL does not select a model. Edit the API entry and expand **Claude model mapping**. Enter the provider’s exact main model ID and, optionally, a separate subagent ID. Claude-family model requests use the main mapping; Haiku helper requests and requests marked with `x-claude-code-agent-id` use the subagent mapping, or the main mapping when no subagent is configured. Explicit non-Claude main model IDs are preserved. Tools, history, thinking and capability declarations are not rewritten. CLI `add api` and `edit` offer the same optional mappings; blank keeps the existing value, and `-` clears it.

The main mapping is also added through Claude Code’s documented `ANTHROPIC_CUSTOM_MODEL_OPTION` mechanism. Reopen Claude Code after configuring it to load the custom `/model` entry; existing processes do not reload their environment from a proxy response. Provider mapping affects subsequent requests without restarting easy-switch. Gateway discovery alone is insufficient: Claude currently filters discovery IDs that do not contain `claude` or `anthropic`, which can hide DeepSeek even when the provider lists it.

Mappings belong to individual APIs. For CLI requests using a Claude-family alias, a fallback subscription receives the client’s original model ID. Desktop selections and explicit CLI non-Claude model IDs instead stay fixed across fallback; a Claude subscription is skipped for DeepSeek selections. Explicitly selecting a DeepSeek ID in the client does not give a Claude subscription access to that ID. Cross-family fallback still requires compatible model IDs and conversation formats. A model name mapping cannot supply missing tool-use or agent support in the upstream. The official-client integration test executes a real Agent tool through simulated main/subagent upstreams; it does not establish compatibility with any specific live reseller.

**Switching:** the next Messages request reads the current provider, including tool-result continuations. HTTP quota/authentication/model-access rejections, transient connection/server failures and startup SSE errors can try alternatives before output is accepted. Only a successful fallback becomes active. Quota/model cooldowns are scoped to provider and model; authentication failures cool down that provider. If no route succeeds, errors retain all attempts. Desktop upstream 401/402 failures are returned as gateway 502 errors with their original statuses in the details; invalid local tokens still receive 401, preventing upstream failures from falsely invalidating the local credential. Anthropic version/beta headers, message history, tools and response rate-limit headers are preserved. Accepted output/tool calls are never replayed. Incompatible model IDs, thinking signatures, context sizes or tools can still cause failures across providers. This is routing within one client; Codex conversations are not converted into Claude Code conversations. Claude subscription quota rings and Codex image borrowing are not included. There is no task-list or per-session model-selection UI.

**DeepSeek:** official documentation now provides [Responses for Codex](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/) with base `https://api.deepseek.com`, and [Anthropic compatibility for Claude Code](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/) with base `https://api.deepseek.com/anthropic`. Use a currently available DeepSeek model ID. A third-party reseller must separately confirm it exposes these protocols.

Official references: [authentication](https://code.claude.com/docs/en/authentication), [gateway connection](https://code.claude.com/docs/en/llm-gateway-connect), [gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol), [model configuration](https://code.claude.com/docs/en/model-config), [subagents](https://code.claude.com/docs/en/sub-agents). Anthropic does not guarantee compatibility with non-Claude models; DeepSeek documents and maintains its own compatibility layer.

## 简体中文

在桌面顶部选择 **Claude**，即可管理独立于 Codex 的服务商和备用顺序。Claude Code CLI 与 Claude Desktop 共用这套服务商、当前选择、凭据与备用顺序，所有客户端可以同时运行；顶部选择器只决定正在编辑哪份列表。

**客户端配置：**CLI 适配器写入用户级 `settings.json`；Desktop 适配器独立写入[第三方推理 profile](https://code.claude.com/docs/en/llm-gateway-connect#desktop-app)。先打开 Claude Desktop 一次以创建配置目录。添加至少一个 Claude 服务商后，easy-switch 桌面应用会检测该目录，注册指向 `http://127.0.0.1:18345/claude-desktop` 的 profile。路由启停后需完全退出并重新打开 Desktop，仅最小化窗口不会重新加载配置。Linux systemd 命令行安装仍只自动配置 Claude Code CLI。

Desktop 按需读取所有已配置 Claude 服务商模型目录的并集，按模型 ID 去重，每个服务商缓存一分钟，不进行后台轮询。目录临时读取失败时保留已观察到的 ID，某个服务商不可用不会隐藏其他服务商的模型；成功返回空目录或删除服务商后会移除对应条目。无法发现目录时也纳入手动填写的映射。菜单显示真实模型名称，说明统一为 `easy-switch · <模型 ID>`。非 Claude 模型使用稳定、独立的兼容内部路由 ID，避免官方名称覆盖，发送前转换为真实上游 ID。明确选择的模型优先于主模型、子代理默认映射，`[1m]` 后缀或 agent 请求头也不会覆盖选择。未明确选模型的请求使用当前服务商映射或其目录首项，随后在本次请求内固定：切换和重试不得改用另一服务商的默认模型；已知不提供该模型的服务商会被跳过。CLI 网关的模型发现接口返回相同并集与原始 ID，服务商放大镜仍只查询该条目。上游切换不改变本地 profile ID、地址与令牌，已接入会话共用一个 easy-switch 网关。从 0.5.7 及更早版本升级后需完全重启 Desktop 一次，刷新模型菜单。映射不会授予模型权限，也不能补全上游缺失的工具能力。此适配接入 Desktop 网关，不修改订阅计划、官方托管云环境或 Remote Control。

macOS 配置位于 `~/Library/Application Support/Claude` 与 `Claude-3p`；Windows 位于 `%LOCALAPPDATA%/Claude` 与 `Claude-3p`，兼容检测到的目录变体；Linux 位于 `$XDG_CONFIG_HOME/Claude` 与 `Claude-3p`，默认使用 `~/.config`。easy-switch 管理两个 `claude_desktop_config.json` 中的 `deploymentMode` 及自己的 `configLibrary` profile 与注册信息，写入前记录原值。停止、退出及异常崩溃会恢复原配置，保留其他设置、MCP、其他 profile 和用户并发修改。真实上游密钥留在 easy-switch，Desktop profile 仅保存本地令牌。测试通过 `SWITCH_CLAUDE_DESKTOP_HOME` 隔离目录；网关请求、故障转移及恢复已由模拟上游和真实 easy-switch Electron 测试覆盖；真实 DeepSeek 上游已通过代理完成最小 Messages、流式响应、自适应推理及工具调用探测，尚不能等同于 Claude Desktop 全流程或全部 agent 功能验证。

接入 DeepSeek：点击服务商放大镜，在真实模型目录点击**设为主模型**／**设为子代理模型**；也可在 **Claude 模型映射** 中手动填写准确 ID。CLI 新开 `claude` 会话后，用 `/status` 确认本地代理地址、`/model` 查看自定义模型；Desktop 首次重启后直接选择真实模型名称。上游需支持 Anthropic Messages、流式响应和工具调用，模型名称映射无法补全缺失的协议能力；暂未实现 OpenAI Chat／Responses 到 Messages 的转换。

**API：**点击**添加 API 服务商**。Base URL 留空使用 `https://api.anthropic.com`。第三方必须支持 Anthropic Messages 协议及 Bearer 或 `x-api-key` 认证，仅支持 OpenAI 协议的地址不能直接使用。填写地址时不附加 `/v1/messages`；已有 `/v1` 后缀也可识别。

**订阅：**先安装[官方 Claude Code](https://code.claude.com/docs/en/setup)，再点击**添加订阅**。软件通过隔离的 `CLAUDE_CONFIG_DIR` 运行官方 `claude auth login --claudeai`，在浏览器完成认证，并按提示将授权码粘贴到对话框。macOS 可能请求官方客户端写入、easy-switch 读取隔离登录的钥匙串权限；Linux/Windows 使用官方凭据文件。OAuth 凭据随后复制到受权限保护的账号目录，访问令牌临近过期时刷新，必要时重新启动官方认证。本机正常客户端的订阅登录不会被替换。也可通过**导入现有登录方式**复制本机已有的 API 配置或订阅。

Claude Code 需单独安装，不包含在 easy-switch 的 MIT 分发包中。非标准安装位置可使用 `SWITCH_CLAUDE_BIN` 指定可执行文件。订阅认证需要支持 `claude auth login` 的当前版本。

添加首个服务商后，重新打开 Claude Code 一次。运行期间，用户级 `settings.json` 将请求指向 `http://127.0.0.1:18345/claude`，并使用仅供本地路由的令牌；代理只向上游发送当前选中的凭据。退出后恢复原连接配置，保留其他设置和用户并发修改；异常退出也由恢复助手处理。命令行、项目、托管策略、扩展或云服务配置可能覆盖用户级设置，流量未经过本地代理时请检查这些来源。

Linux 复用现有 systemd 服务，上面的命令示例同样适用。首次 `add` 后写入 Claude 路由；重复执行 `switch claude add account <已有别名>` 可以重新认证，不创建重复条目。SSH 终端中可粘贴浏览器返回的授权码。卸载服务时同时恢复 Codex 和 Claude 配置；Linux 安装器仍需满足既有 systemd、Codex CLI 等前提。

**模型查询：**点击任意 Claude 服务商行的放大镜，读取该条目自身的 `/v1/models`，支持分页，未选中的条目也可查询。API 查询返回 404/405 时，可继续尝试同主机的 `/models` 及去掉末尾 `/anthropic` 的地址。查询不改变路由，不发送推理请求，也不使用其他服务商目录替代；不支持查询时明确显示错误。

**DeepSeek 模型映射：**只修改 Base URL 不会自动选择模型。编辑 API 条目并展开**Claude 模型映射**，填写服务商实际提供的主模型 ID，可选填子代理 ID。Claude 系列请求使用主映射；Haiku 辅助请求及带 `x-claude-code-agent-id` 的子代理请求使用子代理映射，未填写时沿用主映射。显式选择的非 Claude 主模型 ID 保持原值。工具定义、历史、thinking 及能力声明不会被改写。命令行添加、编辑 API 也提供同样的可选项：留空保留已有值，`-` 清除。

主模型同时通过官方 `ANTHROPIC_CUSTOM_MODEL_OPTION` 机制加入 Claude 的自定义 `/model` 入口。配置后重新打开 Claude Code，菜单才会读取新的环境；代理响应不能刷新已运行客户端的环境变量。服务商映射本身对后续请求生效，无需重启 easy-switch。仅靠网关模型发现不足以显示 DeepSeek：Claude 当前会过滤不含 `claude` 或 `anthropic` 的发现结果。

映射仅属于对应 API。CLI 使用 Claude 系列别名时，备用订阅收到客户端原始模型 ID；Desktop 选定模型或 CLI 明确指定非 Claude ID 时，备用重试保持该模型，DeepSeek 选择会跳过 Claude 订阅。如果在客户端显式选择 DeepSeek ID，Claude 订阅并不会获得该模型的访问能力。跨模型体系切换仍需兼容的 ID 和上下文格式。映射只能解决命名，无法补全服务商缺失的工具或 agent 协议。本项目用真实官方客户端及模拟上游验证了 Agent 工具、主模型和子代理续接，尚未验证特定第三方服务商的实际兼容性。

后续 Messages 请求读取新路由，包括工具结果续接。额度、认证、模型访问拒绝、暂时的连接或服务器故障、启动 SSE 错误可在接受输出前尝试备用服务。仅成功的备用服务商会变为当前选择；额度、模型冷却按服务商和模型隔离，认证失败按服务商冷却。无路由成功时保留所有尝试；Desktop 上游 401/402 转为网关 502，详情保留原始状态，本地令牌无效才返回 401，避免客户端误判本地密钥失效。版本、beta 请求头、消息历史、工具定义和额度响应头保留。已接受的输出及工具调用不会重放。模型名称、思考签名、上下文长度和工具不兼容仍可能导致失败。此功能不在两个客户端之间转换会话。首批适配不包含 Claude 订阅额度圈、Codex 图片借用；不提供任务列表或按会话选择模型的界面。

**DeepSeek：**目前官方已分别提供 Codex Responses 地址 `https://api.deepseek.com` 和 Claude Code Anthropic 兼容地址 `https://api.deepseek.com/anthropic`，需选择其实际提供的模型。第三方中转商是否暴露这两种协议，应向该服务商确认。Claude 官方不保证非 Claude 模型的兼容性，DeepSeek 的适配由其自身维护。

**Session scope / 会话范围：** Existing sessions already connected to the easy-switch gateway keep the same connection while upstreams change. Restart Desktop once after initial setup to load the gateway; a proxy cannot redirect requests from a process still connected directly to another endpoint or convert hosted conversations into local gateway sessions. / 已接入 easy-switch 网关的现有会话在切换上游时维持相同连接。首次接入后完全重启 Desktop 一次；代理无法改道仍直连其他地址的旧进程，也不能把官方托管会话转换为本地网关会话。

**Gateway errors / 网关报错：**`Gateway returned an error` means the inference test was rejected. The proxy reports the attempted upstream model and a bounded, credential-redacted error message. `Folder not found` is a separate local working-directory issue; choose an existing folder in Desktop. / 前者表示推理测试被拒绝，代理返回实际尝试模型与脱敏后的有限错误信息；后者属于本地工作目录问题，需要在 Desktop 重新选择存在的文件夹。
