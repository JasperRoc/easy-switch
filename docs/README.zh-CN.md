[English](../README.md) · **简体中文**

# easy-switch：更好的 AI 会话体验

![Node.js](https://img.shields.io/badge/Node.js-22%2B-417E38?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-2563EB?style=flat-square)
![Status](https://img.shields.io/badge/Status-Experimental-D97706?style=flat-square)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)

easy-switch 是面向 **Codex、Claude Code CLI 与 Claude Desktop** 的桌面及命令行路由工具，统一管理 ChatGPT、Claude 订阅账号、官方 API 与第三方兼容 API。Codex 与 Claude 分别保存服务商列表和备用优先级，Claude CLI 与 Desktop 共用 Claude 列表。它在模型请求边界切换上游，保持客户端进程与会话连续；符合条件的额度或认证错误会按优先级尝试备用服务。

🔄 **会话内切换** · 🖥️ **托盘与菜单栏操作** · 🌊 **海洋玻璃界面 · 中英切换 · 明暗主题** · 🔍 **服务商模型查询** · ⚙️ **自动故障切换**

[快速开始](#quick-start) · [与现有工作的区别](#why-easy-switch) · [FAQ](#faq) · [免责声明](#disclaimer) · [参与贡献](#contributing) · [许可证](#license)

<a id="quick-start"></a>

## 🚀 快速开始

### 🖥️ Windows 与 macOS

从 [GitHub Releases](https://github.com/JasperRoc/easy-switch/releases) 下载对应安装包：

| 系统 | 安装包 |
| --- | --- |
| Windows 10/11 x64 | `easy-switch-<版本>-win-x64.exe` |
| macOS 13+ · Apple 芯片 | `easy-switch-<版本>-mac-arm64.dmg` |
| macOS 13+ · Intel | `easy-switch-<版本>-mac-x64.dmg` |

1. 安装并启动 **easy-switch**，无需额外安装 Node.js 或用于登录的 Codex 程序，安装包已内置。
2. 选择 **Codex** 或 **Claude**，再点击 **添加订阅**、**添加 API 服务商** 或 **导入现有登录方式**。Base URL 留空使用对应客户端的官方 API：Codex 使用 OpenAI，Claude 使用 Anthropic。Claude 订阅认证自动识别官方 Claude Code CLI 或 VS Code 插件内置程序，并启动浏览器认证；macOS 可能请求钥匙串读取权限。
3. 左侧客户端图标进入对应服务商列表，每栏显示当前服务商与独立路由开关。底部只有 **设置**，语言、外观、开机启动、更新及仓库入口统一放入其中，偏好与路由选择自动保存。
4. 首次接入后，重启对应客户端或重载编辑器窗口，使其读取本地路由。单击托盘或菜单栏图标可重新打开窗口，右键可选择客户端并切换服务商。按住左侧六点柄调整优先级，点击铅笔图标修改别名、地址或密钥，也可以删除服务商；编辑时密钥留空即保留原值。点击每行的放大镜可查询或编辑该服务商的模型目录，不改变当前路由。模型 ID 与显示名称分开保存，可添加、删除和拖拽排序，点击保存后生效；恢复自动目录即可重新使用实时发现。模型与推理强度在会话客户端内选择；Claude API 添加时只填写别名、地址与密钥，添加后可在编辑或目录界面配置可选的 Fable、Opus、Sonnet、Haiku 独立模型映射。

订阅条目根据账号信息显示 Free、Plus、Pro 100、Pro 200 或 Pro 500。额度与购买余额为 0 时正常显示，字段缺失和查询失败分别处理；Codex 刷新后的凭据仅同步到账号及用户身份均匹配的保存副本。

仅安装不会修改客户端配置。关闭窗口后软件继续留在托盘运行；选择 **Quit easy-switch** 会恢复所有客户端的原连接设置。**Start at login** 默认关闭，可自行开启。路由启停后，已打开的客户端可能需要重启或重载；用于会话的客户端需另外安装。认证和协议细节见 [Claude 指南](claude-code.md)。

Claude CLI 与 Desktop 分别写入各自配置，共用同一条路由。已初始化的 Claude Desktop 会自动接入第三方推理配置，路由启停后需完全退出并重新打开 Desktop 一次；持续运行时，切换服务商对后续模型请求生效，无需重写该配置。外网连接在启动时自动采用环境变量或系统 HTTP/HTTPS 代理；已有的手动配置会保留。

Windows 安装包尚无发布者签名；macOS 已使用临时签名并验证应用完整性，但尚无 Developer ID 及 Apple 公证，首次打开仍可能需要系统手动允许。详见[macOS 预览版安装说明](desktop.md#macos-preview-and-the-damaged-app-alert)。Apple 芯片 macOS 已完成打包程序测试；Windows 与 Intel macOS 已构建安装包，仍需在对应系统验证实际运行。生命周期、恢复机制、网络设置及更新方式见[桌面版指南](desktop.md)。

### 🐧 Linux 服务器命令行

需要 **Linux + systemd/logind、Node.js 22+、npm、Git 和 Codex CLI**。请使用运行 Codex 或远程扩展的服务器账号安装。

#### 1. 📦 克隆项目

```bash
git clone https://github.com/JasperRoc/easy-switch.git
cd easy-switch
```

#### 2. ⚙️ 安装工具

```bash
./install.sh
```

安装器注册 `switch` 命令、启动 systemd 后台服务、启用开机启动，并备份和更新 Codex 配置。如果开机启动需要管理员协助，按安装器提示处理即可。首次安装后，重启 Codex 或重载远程编辑器窗口；之后切换上游无需重启。

#### 3. ⌨️ 命令介绍

| 命令 | 作用 |
| --- | --- |
| `switch codex add account <alias>` | 添加 ChatGPT 订阅账号 |
| `switch codex add api <alias>` | 添加官方或第三方 Responses API |
| `switch codex edit <alias>` | 修改别名、Base URL 或密钥，密钥留空保留 |
| `switch codex remove <alias>` | 删除 Codex 服务商及其独立保存的登录 |
| `switch codex <alias>` | 切换 Codex 后续请求使用的服务商 |
| `switch codex list` | 查看 Codex 备用优先级及当前上游（`*`） |
| `switch claude add api <alias>` | 为 Claude Code 添加 Anthropic Messages API |
| `switch claude add account <alias>` | 通过官方认证添加或重新认证 Claude 订阅 |
| `switch claude <alias>` | 切换 Claude Code 的服务商，不影响 Codex |
| `switch claude edit / remove <alias>` | 修改或删除 Claude 服务商 |
| `switch claude list / order` | 管理 Claude 独立的服务商和优先级 |
| `switch codex order` | 用键盘调整 Codex 切换优先级 |
| `switch update` | 更新至官方仓库 main 分支并重启服务 |
| `switch current` | 分别显示 Codex、Claude 当前服务商 |
| `switch codex current / switch claude current` | 仅查看指定客户端的当前别名 |
| `switch service status` | 查看后台服务状态 |
| `switch service restart` | 重启服务，会中断进行中的请求 |
| `switch service uninstall` | 恢复配置并移除服务 |
| `switch help` | 查看命令帮助 |

Codex 与 Claude 的服务商、凭据、当前选择和备用队列相互独立，允许使用同名别名。原有无前缀的 `add`、`edit`、`remove`、`list`、`order` 和别名切换继续管理 Codex。删除当前服务商后会选择队列中第一个剩余条目；删除账号仅清理 easy-switch 独立保存且未被其他条目共用的登录，不删除外部客户端凭据和会话。删除最后一个 Claude 服务商会恢复其客户端配置。

添加 API 时，**Base URL 留空即使用 OpenAI 官方 API**（`https://api.openai.com/v1`），并填写对应的 OpenAI API Key；接入第三方服务时，填写其 Base URL 与 API Key。第三方地址不应附加 `/responses`，且需支持 Responses API、SSE 与 Codex 工具调用。

进入 `switch codex order` 或 `switch claude order` 后，用 **↑/↓** 选择，**Shift+↑/↓**（或大写 **K/J**）移动，**Enter** 保存，**Esc** 或 **Ctrl+C** 取消。优先级从上到下递减，保存顺序不会改变当前上游。

模型及推理强度由 Codex 或 Claude Code 自身管理。桌面版每行的放大镜独立查询该服务商，包括未选中的服务商，并提供目录编辑、搜索、刷新状态与读取时间，修改在点击保存前仅为草稿。两个客户端分别接入各自所有服务商的模型并集，实际请求保留所选模型 ID。Codex 按版本系列从新到旧集中排列，系列内沿用官方顺序，对话菜单排除图片专用模型与隐藏模型。模型 ID 仅来自服务商或用户手动条目，不设置默认模型集；推理强度使用订阅实时信息或本地官方客户端对同名模型的元数据。目录中的模型仍需具备实际推理和工具调用权限。详见[服务商模型查询](usage.md#provider-model-lookup)及 [Claude 模型映射](claude-code.md)。

安装后重新打开 Bash/Zsh 终端，即可使用 **Tab 补全**，例如 `switch per<Tab>` 补全账号别名、`switch service re<Tab>` 补全子命令。当前终端可执行 `source ~/.bashrc`，Zsh 用户执行 `source "${ZDOTDIR:-$HOME}/.zshrc"`。添加 API 时只需填写地址和密钥，文字请求的模型与推理强度沿用 Codex 当前配置。

后续运行 `switch update` 即可更新，无需进入源码目录。更新会重启后台代理，请在当前任务结束后执行。尚无此命令的旧版本需先执行一次 `git pull --ff-only` 和 `./install.sh`。 如果 0.1.1 及更早版本因模型设置变化而阻止更新，也请通过上述源码安装方式升级一次。

如果服务器需要外网代理，请在安装或更新前设置 `HTTP_PROXY` / `HTTPS_PROXY`。工具会保存代理设置，供后台服务和后续更新使用；本机地址始终直连。详见[外网代理配置](usage.md#outbound-network-proxy)。

账号认证、数据存储和自动切换规则详见[运维指南](usage.md)。

<a id="why-easy-switch"></a>

## 🔎 与现有工作的区别

easy-switch 面向桌面及 Linux 服务器上的个人 Codex 与 Claude Code 工作流，重点解决账号与 API 切换时的会话连续性问题。其设计侧重于 **精简配置、可选桌面集成、SSH 环境下的可操作性，以及明确可控的故障切换顺序**。

| 项目 | 主要定位 | easy-switch 的适用优势 |
| --- | --- | --- |
| [CC Switch](https://github.com/farion1231/cc-switch) | 面向多种 AI 工具的桌面管理应用，支持本地路由和自动故障切换 | 全程通过 SSH 终端管理账号和优先级，由 systemd 独立运行，适合没有桌面环境的服务器。 |
| [Sub2API](https://github.com/Wei-Shaw/sub2api) | 提供账号管理与共享的订阅中转服务，文档中的技术栈包含 PostgreSQL 和 Redis | 使用 Node.js 和本地文件完成个人切换，无需部署数据库、缓存或 Web 管理面板。 |
| [New API](https://github.com/QuantumNous/new-api) | 统一模型聚合、分发与协议转换平台 | 将已有的 Responses 兼容服务直接接入 Codex 工作流，减少个人用户配置完整分发平台的步骤。 |

easy-switch 将账号配置、路由选择与备用排序集中在托盘应用或命令行接口中，降低个人用户的配置与运维步骤。其差异主要体现在部署方式与交互设计；请求级热切换本身并非本项目独有的机制。

<a id="faq"></a>

## ❓ FAQ

### 是否考虑引入其他 AI 服务商？

Codex 支持 Responses 兼容 API 与 ChatGPT 订阅；Claude Code 支持 Anthropic Messages 兼容 API 与 Claude 订阅。DeepSeek 已提供 [Codex 接入说明](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)和 [Claude Code 接入说明](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/)。请分别填写对应协议的地址，并选择服务商实际提供的模型；第三方 API Key 本身不代表同时支持两种协议。Gemini 订阅登录尚未实现。

### Claude Desktop 如何使用第三方模型？

先打开 Claude Desktop 一次，在 **Claude** 下添加服务商，再完全退出并重新打开 Desktop。Desktop 与 CLI 会共同发现所有已配置 Claude 服务商的模型：订阅的 Fable、Opus、Haiku 与三个 DeepSeek 真实名称可以同时出现。内部兼容路由 ID 可避免 CLI 过滤非 Claude 条目。选择 DeepSeek 条目时，重试保持该模型；也可在 API 条目中独立设置 **Fable／Opus／Sonnet／Haiku** 映射，例如 Fable → DeepSeek V4 Pro、Opus → DeepSeek V4.1 Flash、Haiku → DeepSeek V4 Flash，规则由你决定。系列请求会在备用服务商上应用其各自映射，订阅则使用原始 Claude 模型。仅显示官方菜单的客户端同样可使用这些映射。升级后请重启客户端刷新目录；内置条目和托管策略限制仍然生效。上游需支持 Anthropic Messages、流式响应与工具调用。配置、示例和测试范围见 [Claude 指南](claude-code.md)。

### 为什么 Codex 列出了我的 API 不支持的模型？

旧版 easy-switch 未向 Codex 提供模型菜单，保存的模型偏好或客户端内置目录可能显示服务商没有的模型。从 0.5.12 起，Codex 通过已认证的原生目录接口读取订阅实时目录、API `/models` 与手动条目的并集。升级后重启 Codex 或重载编辑器一次。已有模型偏好不会被静默替换；旧模型不可用时，请在客户端选择当前目录中的模型。[官方 GPT-5.5 退役通知](https://learn.chatgpt.com/docs/models#gpt-55-retirement)适用于 ChatGPT 登录，API 是否提供该模型取决于具体服务商。目录中的模型仍需兼容 Responses 与工具调用。

Codex 上游明确拒绝模型不存在、不支持或无权使用时，easy-switch 会在接受输出前保留同一模型，按备用顺序重试；优选路由保持不变，因此 Free 仍可优先处理它支持的模型，其他模型交给 API。拒绝结果按“服务商＋模型”缓存 60 秒，手动选择服务商会清空缓存。新鲜目录明确不含该模型的服务商会跳过；目录读取失败表示未知，不视为不支持。HTTP 500/502/503/504/529 与连接失败也会在接受输出前尝试备用。没有服务商提供所选模型时，需要换模型或添加有权限的方式，软件不会静默替换成其他模型。客户端内部拦截、尚未到达代理的请求无法重路由。

### 是否考虑适配其他系统？

现已提供 Windows x64、macOS Apple 芯片及 Intel 的桌面安装包，同时保留 Linux systemd 命令行安装方式。桌面版仅在应用运行期间接管路由，Linux 版由 systemd 服务管理。Apple 芯片 macOS 已完成打包程序测试，Windows 和 Intel macOS 仍需原生运行验证。详见[桌面版指南](desktop.md)。

### 能否查看订阅额度？

桌面版 Codex 账号行直接读取账号额度接口：Plus 使用同一个环，上方小段弧线显示 5 小时剩余额度、下方大段弧线显示周剩余额度；Pro 显示周额度整环。悬停某段弧线，会轻微浮起并显示对应的剩余百分比和重置时间。额度圈采用中性灰色弧线与中心菱形。购买额度独立于时间窗口，悬停或键盘聚焦中心菱形即可查看余额，不再另设余额展示块，也无需等周额度耗尽。窗口显示时每分钟刷新额度，隐藏或最小化后暂停自动查询；读取失败后逐步延长重试间隔。点击不再展开全部信息。时间窗口耗尽且购买余额为 0 时，显示浅灰描边圆圈与感叹号；有购买余额时继续独立显示。套餐名称支持 Free、Go、Plus、Pro 100／200／500，Go 按接口实际返回的窗口显示，只有 5 小时窗口时不会误画成缺失的周额度。缺失数据和读取失败会明确提示，不估算余额，也不会自动使用重置卡。

### 能否使用额度重置卡？

桌面版订阅条目提供重置按钮。打开后可查看每张卡及其过期时间，选择后再确认使用。卡片按过期时间排列，过期卡不可选择；未返回的明细及有效期会明确提示。功能使用[官方账号重置接口](https://learn.chatgpt.com/docs/app-server#8-earned-rate-limit-resets-chatgpt)，结果不明确时重试会沿用同一请求标识，之后重新读取卡片及额度。使用重置卡不会改变购买额度或当前服务商。

### 文字使用 API 时，可以借用订阅生成图片吗？

可以。经过 easy-switch 的内置图片生成、编辑请求会按优先级选择可用订阅，不改变当前文字服务商和模型。前提是 Codex 已提供内置图片工具。桌面版通过本地 actor 认证启用图片工具，文字接入保持本地 API 网关身份，避免某个订阅额度耗尽时阻止向其他服务商发送消息；真实图片权限仍由上游决定。添加订阅后会配置原生图片工具；Codex 原先使用 API 认证时，会临时接入已添加的订阅登录。首次配置后，已打开的 Codex 需要重载一次，之后切换服务商仍保留图片工具；退出 easy-switch 会恢复原始连接及临时接入前的登录。详见[图片路由](usage.md#image-generation-routing)。

Free 账号不提供 Codex 图片生成。easy-switch 会跳过已识别的 Free 图片上游；原生登录为 Free 时，可临时接入已添加且有权限的付费账号来启用工具，随后需要重载 Codex 一次。没有可用订阅时，图片 API 可处理到达代理的请求，但不能启用被 Free 客户端禁用的工具。输出前的计划或模型权限拒绝可尝试其他账号；内容安全拒绝不会通过其他服务商重试。

### 选择 API 后，为什么 Codex 仍显示订阅登录？

桌面版为启用 Codex 内置图片工具，会临时接入订阅身份。Codex 的账号标识描述原生登录身份，实际请求上游由 easy-switch 单独选择：选中 API 后，文字请求使用该 API 的密钥；图片请求使用订阅。服务商列表下方会明确提示这一区别。停止路由或退出 easy-switch 会恢复原始配置及临时接入前的登录。Codex 自带账号卡只显示一个原生身份及 easy-switch 服务商名称；新增账号在 easy-switch 可滚动的服务商列表和托盘菜单中管理。

### 切换后，当前任务会中断吗？

顶部当前服务商表示后续文字请求默认使用的服务商，成功自动切换后会同步更新；已经开始的请求可能仍在原服务商上完成，图片路由单独处理。手动切换对同一会话的后续模型请求生效，包括 Claude Desktop 的任务续接；符合条件的上游拒绝可通过备用服务重试。对于 Codex HTTP 或 SSE 启动阶段的“Selected model is at capacity”，在接受任何输出前尝试可用备用服务，再进行最多两次延迟重试。已接受的文字和工具事件不会重放。响应中途断流、上下文格式不兼容或全部备用不可用时，任务仍可能中断。

<a id="disclaimer"></a>

## ⚠️ 免责声明

easy-switch 是独立社区项目，与 OpenAI、Anthropic 无隶属关系，也未获得其背书。请仅使用你有权访问的账号和 API，并遵守对应服务商的条款。切换上游会将所需的会话历史发送给选中的服务商。凭据保存在本地，并通过文件权限保护。

本项目处于实验阶段。已通过真实 Codex、Claude Code 进程与模拟上游验证同会话切换；真实服务商访问、VS Code Remote 界面及服务器重启恢复仍需端到端验证。部署前请阅读完整[免责声明](DISCLAIMER.md)与[运行限制](usage.md#protocol-support-and-limits)。

<a id="contributing"></a>

## 🤝 参与贡献

欢迎提交问题报告、兼容性验证结果、文档改进和范围集中的 Pull Request。报告问题时，请附上复现步骤与运行环境，并移除日志中的凭据和私人会话内容。

开发环境与贡献流程见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

<a id="license"></a>

## 📄 许可证

[MIT](LICENSE) © 2026 easy-switch contributors。
