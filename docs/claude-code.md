# Claude Code / Claude Code 接入

[English README](../README.md) · [简体中文 README](README.zh-CN.md)

## English

Select **Claude Code** at the top of the desktop window. Its providers, active route and fallback order are independent of Codex. Both clients can use the same running easy-switch application at once; changing this selector only chooses which configuration you are editing.

**Client scope:** automatic configuration currently targets **Claude Code CLI** (`claude` in a terminal). Claude Desktop’s normal chat page is a different client; its model menu is not the CLI’s `/model` menu. The Desktop Code tab also does not adopt `ANTHROPIC_BASE_URL` from `settings.json`: it needs [Desktop’s separate third-party inference setup](https://code.claude.com/docs/en/llm-gateway-connect#desktop-app). The official entry is **Help → Troubleshooting → Enable Developer Mode**, then **Developer → Configure Third-Party Inference**. That setup uses its own gateway requirements; easy-switch does not yet implement or configure that Desktop gateway contract. Pointing it at the current Messages proxy alone is not a supported integration. With an ordinary Claude account, a Free plan’s “Get Claude Code” page is an access prompt, not a model-mapping error; see [Desktop quick start](https://code.claude.com/docs/en/desktop-quickstart). Third-party API credentials do not grant that account a paid plan.

To use DeepSeek with the supported CLI workflow, query the provider’s catalog, edit its **Claude model mapping** with the exact main model ID (and optional subagent ID), then open a new `claude` session. Use `/status` to confirm the local base URL and `/model` for the custom entry. The provider must support Anthropic Messages, streaming and tool calls; a model-name mapping cannot supply missing protocol capabilities.

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

Mappings belong to individual APIs. A fallback subscription receives the client’s original model ID, so a normal Claude-family request mapped to DeepSeek can fall back to Claude. Explicitly selecting a DeepSeek ID in the client does not give a Claude subscription access to that ID. Cross-family fallback still requires compatible model IDs and conversation formats. A model name mapping cannot supply missing tool-use or agent support in the upstream. The official-client integration test executes a real Agent tool through simulated main/subagent upstreams; it does not establish compatibility with any specific live reseller.

**Switching:** the next Messages request reads the current provider, including tool-result continuations. HTTP quota/authentication rejections and startup overload errors can try alternatives before output is accepted. Anthropic version/beta headers, message history, tools and response rate-limit headers are preserved. Accepted output/tool calls are never replayed. Incompatible model IDs, thinking signatures, context sizes or tools can still cause failures across providers. This is routing within one client; Codex conversations are not converted into Claude Code conversations. Claude subscription quota rings and Codex image borrowing are not included. There is no task-list or per-session model-selection UI.

**DeepSeek:** official documentation now provides [Responses for Codex](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/) with base `https://api.deepseek.com`, and [Anthropic compatibility for Claude Code](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/) with base `https://api.deepseek.com/anthropic`. Use a currently available DeepSeek model ID. A third-party reseller must separately confirm it exposes these protocols.

Official references: [authentication](https://code.claude.com/docs/en/authentication), [gateway connection](https://code.claude.com/docs/en/llm-gateway-connect), [gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol), [model configuration](https://code.claude.com/docs/en/model-config), [subagents](https://code.claude.com/docs/en/sub-agents). Anthropic does not guarantee compatibility with non-Claude models; DeepSeek documents and maintains its own compatibility layer.

## 简体中文

在桌面顶部选择 **Claude Code**，即可管理它独立的服务商、当前路由和备用顺序。两个客户端可以同时使用同一个 easy-switch；顶部选择器只决定正在编辑哪一套配置。

**客户端范围：**目前自动配置的是终端中的 **Claude Code CLI**（`claude`）。Claude 桌面普通聊天属于另一个客户端，其模型菜单不是 CLI 的 `/model` 菜单。桌面 Code 页面同样不会采用 `settings.json` 中的 `ANTHROPIC_BASE_URL`，需要[桌面端独立的第三方推理配置](https://code.claude.com/docs/en/llm-gateway-connect#desktop-app)。官方入口是 **Help → Troubleshooting → Enable Developer Mode**，随后进入 **Developer → Configure Third-Party Inference**；该方式有独立的网关要求，easy-switch 尚未实现或自动配置这套桌面网关协议，不能只把现有 Messages 代理地址填进去就认为完成接入。普通 Claude 账号为 Free 时出现“获取 Claude Code”，属于入口权限提示，不是模型映射错误，见[桌面版快速开始](https://code.claude.com/docs/en/desktop-quickstart)。第三方 API 凭据不会使此账号获得付费计划。

使用已支持的 DeepSeek CLI 方式：查询服务商目录，在条目的 **Claude 模型映射** 中填写准确的主模型 ID，可选填子代理 ID，然后新开 `claude` 会话。用 `/status` 确认本地代理地址，`/model` 查看自定义模型选项。上游需支持 Anthropic Messages、流式响应和工具调用，模型名称映射无法补全缺失的协议能力。

**API：**点击**添加 API 服务商**。Base URL 留空使用 `https://api.anthropic.com`。第三方必须支持 Anthropic Messages 协议及 Bearer 或 `x-api-key` 认证，仅支持 OpenAI 协议的地址不能直接使用。填写地址时不附加 `/v1/messages`；已有 `/v1` 后缀也可识别。

**订阅：**先安装[官方 Claude Code](https://code.claude.com/docs/en/setup)，再点击**添加订阅**。软件通过隔离的 `CLAUDE_CONFIG_DIR` 运行官方 `claude auth login --claudeai`，在浏览器完成认证，并按提示将授权码粘贴到对话框。macOS 可能请求官方客户端写入、easy-switch 读取隔离登录的钥匙串权限；Linux/Windows 使用官方凭据文件。OAuth 凭据随后复制到受权限保护的账号目录，访问令牌临近过期时刷新，必要时重新启动官方认证。本机正常客户端的订阅登录不会被替换。也可通过**导入现有登录方式**复制本机已有的 API 配置或订阅。

Claude Code 需单独安装，不包含在 easy-switch 的 MIT 分发包中。非标准安装位置可使用 `SWITCH_CLAUDE_BIN` 指定可执行文件。订阅认证需要支持 `claude auth login` 的当前版本。

添加首个服务商后，重新打开 Claude Code 一次。运行期间，用户级 `settings.json` 将请求指向 `http://127.0.0.1:18345/claude`，并使用仅供本地路由的令牌；代理只向上游发送当前选中的凭据。退出后恢复原连接配置，保留其他设置和用户并发修改；异常退出也由恢复助手处理。命令行、项目、托管策略、扩展或云服务配置可能覆盖用户级设置，流量未经过本地代理时请检查这些来源。

Linux 复用现有 systemd 服务，上面的命令示例同样适用。首次 `add` 后写入 Claude 路由；重复执行 `switch claude add account <已有别名>` 可以重新认证，不创建重复条目。SSH 终端中可粘贴浏览器返回的授权码。卸载服务时同时恢复 Codex 和 Claude 配置；Linux 安装器仍需满足既有 systemd、Codex CLI 等前提。

**模型查询：**点击任意 Claude 服务商行的放大镜，读取该条目自身的 `/v1/models`，支持分页，未选中的条目也可查询。API 查询返回 404/405 时，可继续尝试同主机的 `/models` 及去掉末尾 `/anthropic` 的地址。查询不改变路由，不发送推理请求，也不使用其他服务商目录替代；不支持查询时明确显示错误。

**DeepSeek 模型映射：**只修改 Base URL 不会自动选择模型。编辑 API 条目并展开**Claude 模型映射**，填写服务商实际提供的主模型 ID，可选填子代理 ID。Claude 系列请求使用主映射；Haiku 辅助请求及带 `x-claude-code-agent-id` 的子代理请求使用子代理映射，未填写时沿用主映射。显式选择的非 Claude 主模型 ID 保持原值。工具定义、历史、thinking 及能力声明不会被改写。命令行添加、编辑 API 也提供同样的可选项：留空保留已有值，`-` 清除。

主模型同时通过官方 `ANTHROPIC_CUSTOM_MODEL_OPTION` 机制加入 Claude 的自定义 `/model` 入口。配置后重新打开 Claude Code，菜单才会读取新的环境；代理响应不能刷新已运行客户端的环境变量。服务商映射本身对后续请求生效，无需重启 easy-switch。仅靠网关模型发现不足以显示 DeepSeek：Claude 当前会过滤不含 `claude` 或 `anthropic` 的发现结果。

映射仅属于对应 API。备用订阅收到客户端原始模型 ID，因此原本的 Claude 请求映射到 DeepSeek 后，可以回退到 Claude；如果在客户端显式选择 DeepSeek ID，Claude 订阅并不会获得该模型的访问能力。跨模型体系切换仍需兼容的 ID 和上下文格式。映射只能解决命名，无法补全服务商缺失的工具或 agent 协议。本项目用真实官方客户端及模拟上游验证了 Agent 工具、主模型和子代理续接，尚未验证特定第三方服务商的实际兼容性。

后续 Messages 请求读取新路由，包括工具结果续接。额度、认证拒绝或流启动时的过载可在接受输出前尝试备用服务；版本、beta 请求头、消息历史、工具定义和额度响应头保留。已接受的输出及工具调用不会重放。模型名称、思考签名、上下文长度和工具不兼容仍可能导致失败。此功能不在两个客户端之间转换会话。首批适配不包含 Claude 订阅额度圈、Codex 图片借用；不提供任务列表或按会话选择模型的界面。

**DeepSeek：**目前官方已分别提供 Codex Responses 地址 `https://api.deepseek.com` 和 Claude Code Anthropic 兼容地址 `https://api.deepseek.com/anthropic`，需选择其实际提供的模型。第三方中转商是否暴露这两种协议，应向该服务商确认。Claude 官方不保证非 Claude 模型的兼容性，DeepSeek 的适配由其自身维护。
