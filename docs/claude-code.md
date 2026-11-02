# Claude Code / Claude Code 接入

[English README](../README.md) · [简体中文 README](README.zh-CN.md)

## English

Select **Claude Code** at the top of the desktop window. Its providers, active route, model selection and fallback order are independent of Codex. Both clients can use the same running easy-switch application at once; changing this selector only chooses which configuration you are editing.

**API:** choose **Add API provider**. An empty Base URL means `https://api.anthropic.com`. Other providers must implement Anthropic Messages and accept `x-api-key`; an OpenAI-compatible address alone is insufficient. Enter the provider’s base address without `/v1/messages`; an existing `/v1` suffix is accepted.

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
switch claude model
switch claude model deepseek-flash
```

The first `add` connects Claude Code to the running local service. Repeating `switch claude add account <existing-alias>` renews that subscription without adding a duplicate. A browser authorization code can be pasted into the SSH terminal. Service uninstall restores Claude settings alongside Codex settings. The Linux installer retains its documented systemd and Codex CLI prerequisites.

**Model discovery:** the provider’s `/v1/models` is queried, including pagination. Discovery failure does not substitute models from another provider. Some Messages-compatible services do not implement this endpoint: use **Specify a model ID**, or `switch claude model <id> [effort]`. Listing or manually naming a model does not establish inference permissions. A global Claude override is associated with its selected provider, so a DeepSeek override is not sent to a Claude subscription fallback; the fallback receives the client’s original model. Choose compatible client models and providers for automatic failover.

**Switching:** the next Messages request reads the current provider, including tool-result continuations. HTTP quota/authentication rejections and startup overload errors can try alternatives before output is accepted. Anthropic version/beta headers, message history, tools and response rate-limit headers are preserved. Accepted output/tool calls are never replayed. Incompatible model IDs, thinking signatures, context sizes or tools can still cause failures across providers. This is routing within one client; Codex conversations are not converted into Claude Code conversations. Claude subscription quota rings, Codex image borrowing and Claude task-title discovery are not included in this first integration. Claude requests are identified by session ID while streaming.

**DeepSeek:** official documentation now provides [Responses for Codex](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/) with base `https://api.deepseek.com`, and [Anthropic compatibility for Claude Code](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/) with base `https://api.deepseek.com/anthropic`. Use a currently available DeepSeek model ID. A third-party reseller must separately confirm it exposes these protocols.

Official references: [authentication](https://code.claude.com/docs/en/authentication), [gateway connection](https://code.claude.com/docs/en/llm-gateway-connect), [gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol). Anthropic does not guarantee compatibility with non-Claude models; DeepSeek documents and maintains its own compatibility layer.

## 简体中文

在桌面顶部选择 **Claude Code**，即可管理它独立的服务商、当前路由、模型和备用顺序。两个客户端可以同时使用同一个 easy-switch；顶部选择器只决定正在编辑哪一套配置。

**API：**点击**添加 API 服务商**。Base URL 留空使用 `https://api.anthropic.com`。第三方必须支持 Anthropic Messages 协议和 `x-api-key` 认证，仅支持 OpenAI 协议的地址不能直接使用。填写地址时不附加 `/v1/messages`；已有 `/v1` 后缀也可识别。

**订阅：**先安装[官方 Claude Code](https://code.claude.com/docs/en/setup)，再点击**添加订阅**。软件通过隔离的 `CLAUDE_CONFIG_DIR` 运行官方 `claude auth login --claudeai`，在浏览器完成认证，并按提示将授权码粘贴到对话框。macOS 可能请求官方客户端写入、easy-switch 读取隔离登录的钥匙串权限；Linux/Windows 使用官方凭据文件。OAuth 凭据随后复制到受权限保护的账号目录，访问令牌临近过期时刷新，必要时重新启动官方认证。本机正常客户端的订阅登录不会被替换。也可通过**导入现有登录方式**复制本机已有的 API 配置或订阅。

Claude Code 需单独安装，不包含在 easy-switch 的 MIT 分发包中。非标准安装位置可使用 `SWITCH_CLAUDE_BIN` 指定可执行文件。订阅认证需要支持 `claude auth login` 的当前版本。

添加首个服务商后，重新打开 Claude Code 一次。运行期间，用户级 `settings.json` 将请求指向 `http://127.0.0.1:18345/claude`，并使用仅供本地路由的令牌；代理只向上游发送当前选中的凭据。退出后恢复原连接配置，保留其他设置和用户并发修改；异常退出也由恢复助手处理。命令行、项目、托管策略、扩展或云服务配置可能覆盖用户级设置，流量未经过本地代理时请检查这些来源。

Linux 复用现有 systemd 服务，上面的命令示例同样适用。首次 `add` 后写入 Claude 路由；重复执行 `switch claude add account <已有别名>` 可以重新认证，不创建重复条目。SSH 终端中可粘贴浏览器返回的授权码。卸载服务时同时恢复 Codex 和 Claude 配置；Linux 安装器仍需满足既有 systemd、Codex CLI 等前提。

**模型与切换：**查询当前服务商 `/v1/models`，支持分页；查询失败不使用其他服务商的模型目录。未实现查询接口的服务可以手动指定模型 ID，但不代表已验证权限。Claude 全局覆盖关联当前服务商，DeepSeek 覆盖不会直接带到 Claude 订阅备用路由，备用使用客户端原始模型。请选择彼此兼容的客户端模型与上游。

后续 Messages 请求读取新路由，包括工具结果续接。额度、认证拒绝或流启动时的过载可在接受输出前尝试备用服务；版本、beta 请求头、消息历史、工具定义和额度响应头保留。已接受的输出及工具调用不会重放。模型名称、思考签名、上下文长度和工具不兼容仍可能导致失败。此功能不在两个客户端之间转换会话。首批适配不包含 Claude 订阅额度圈、Codex 图片借用或 Claude 任务标题读取；Claude 请求仅在流传输期间按会话 ID 显示。

**DeepSeek：**目前官方已分别提供 Codex Responses 地址 `https://api.deepseek.com` 和 Claude Code Anthropic 兼容地址 `https://api.deepseek.com/anthropic`，需选择其实际提供的模型。第三方中转商是否暴露这两种协议，应向该服务商确认。Claude 官方不保证非 Claude 模型的兼容性，DeepSeek 的适配由其自身维护。
