[English](../README.md) · **简体中文**

# easy-switch：更好的 AI 会话体验

![Node.js](https://img.shields.io/badge/Node.js-22%2B-417E38?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-2563EB?style=flat-square)
![Status](https://img.shields.io/badge/Status-Experimental-D97706?style=flat-square)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)

easy-switch 是面向 Codex 的桌面与命令行账号及 API 路由工具，统一管理 **ChatGPT 订阅账号、OpenAI 官方 API 与第三方兼容 API**。它在模型请求边界切换上游，保持客户端进程与会话连续；当上游返回符合条件的额度或认证错误时，按预设优先级尝试备用服务。

🔄 **会话内切换** · 🖥️ **托盘与菜单栏操作** · 🌊 **海洋玻璃界面 · 中英切换 · 明暗主题** · 🧠 **模型及 effort 选择** · ⚙️ **自动故障切换**

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
2. 点击 **添加订阅**、**添加 API 服务商**，或通过 **导入当前 Codex 配置** 自动识别本机已配置的 API 或订阅。Base URL 留空使用 OpenAI 官方 API。
3. 可在窗口顶部切换 **English / 简体中文**，以及 **跟随系统 / 浅色 / 深色**，偏好会自动保存。
4. 首次启动后，重启 Codex 或重载编辑器窗口，使其读取本地路由。右键 Windows 托盘或 macOS 菜单栏图标即可切换服务商；在设置窗口按住左侧六点拖拽柄调整优先级，也可以删除服务商。在**模型与推理**中，先按 Codex 侧栏中的任务名选择正在运行的任务，再设置模型及推理强度；已完成、已取消的任务及内部辅助请求不会列出；需要统一设置时才选择**全局默认**。右上角地球和外观图标用于切换语言与主题。

仅安装不会修改 Codex 配置。关闭窗口后软件继续留在托盘运行；选择 **Quit easy-switch** 才会恢复原连接设置。**Start at login** 默认关闭，可自行开启。路由启停后，已打开的 Codex 客户端可能需要重启或重载；用于会话的 Codex 客户端需另外安装。

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
| `switch add account <alias>` | 添加订阅账号 |
| `switch add api <alias>` | 添加官方或第三方 API |
| `switch <alias>` | 切换后续请求使用的上游 |
| `switch list` | 查看备用优先级及当前上游（`*`） |
| `switch model` | 交互选择模型及 effort，下一次模型请求生效 |
| `switch model current` | 查看当前模型覆盖设置 |
| `switch model reset` | 取消模型与 effort 覆盖 |
| `switch order` | 用键盘调整切换优先级 |
| `switch update` | 更新至官方仓库 main 分支并重启服务 |
| `switch current` | 查看当前别名 |
| `switch service status` | 查看后台服务状态 |
| `switch service restart` | 重启服务，会中断进行中的请求 |
| `switch service uninstall` | 恢复配置并移除服务 |
| `switch help` | 查看命令帮助 |

添加 API 时，**Base URL 留空即使用 OpenAI 官方 API**（`https://api.openai.com/v1`），并填写对应的 OpenAI API Key；接入第三方服务时，填写其 Base URL 与 API Key。第三方地址不应附加 `/responses`，且需支持 Responses API、SSE 与 Codex 工具调用。

进入 `switch order` 后，用 **↑/↓** 选择，**Shift+↑/↓**（或大写 **K/J**）移动，**Enter** 保存，**Esc** 或 **Ctrl+C** 取消。优先级从上到下递减，保存顺序不会改变当前上游。

执行 `switch model` 后，先选择模型，再选择该模型支持的 effort；用 **↑/↓** 选择、**Enter** 确认、**Esc/Ctrl+C** 取消。选择“跟随 Codex”或运行 `switch model reset` 可取消覆盖。设置对同一服务下所有会话的后续模型请求生效，已经开始输出的响应继续完成。API 模式读取服务商 `/models` 返回的目录，保留自定义模型 ID；已知模型结合 Codex 元数据提供 effort，未知模型使用服务商默认值。订阅模式在隔离的 Codex 进程中使用当前账号读取目录。实际访问权限及 Responses/工具调用兼容性仍取决于上游。此功能覆盖请求参数，不同步修改 Codex 原生界面的模型标签或客户端能力配置。详见[模型与 effort](usage.md#model-and-effort-switching)。

安装后重新打开 Bash/Zsh 终端，即可使用 **Tab 补全**，例如 `switch per<Tab>` 补全账号别名、`switch service re<Tab>` 补全子命令。当前终端可执行 `source ~/.bashrc`，Zsh 用户执行 `source "${ZDOTDIR:-$HOME}/.zshrc"`。添加 API 时只需填写地址和密钥，没有设置 `switch model` 覆盖时，模型沿用 Codex 当前配置。

后续运行 `switch update` 即可更新，无需进入源码目录。更新会重启后台代理，请在当前任务结束后执行。尚无此命令的旧版本需先执行一次 `git pull --ff-only` 和 `./install.sh`。 如果 0.1.1 及更早版本因模型设置变化而阻止更新，也请通过上述源码安装方式升级一次。

如果服务器需要外网代理，请在安装或更新前设置 `HTTP_PROXY` / `HTTPS_PROXY`。工具会保存代理设置，供后台服务和后续更新使用；本机地址始终直连。详见[外网代理配置](usage.md#outbound-network-proxy)。

账号认证、数据存储和自动切换规则详见[运维指南](usage.md)。

<a id="why-easy-switch"></a>

## 🔎 与现有工作的区别

easy-switch 面向桌面及 Linux 服务器上的个人 Codex 工作流，重点解决账号与 API 切换时的会话连续性问题。其设计侧重于 **精简配置、可选桌面集成、SSH 环境下的可操作性，以及明确可控的故障切换顺序**。

| 项目 | 主要定位 | easy-switch 的适用优势 |
| --- | --- | --- |
| [CC Switch](https://github.com/farion1231/cc-switch) | 面向多种 AI 工具的桌面管理应用，支持本地路由和自动故障切换 | 全程通过 SSH 终端管理账号和优先级，由 systemd 独立运行，适合没有桌面环境的服务器。 |
| [Sub2API](https://github.com/Wei-Shaw/sub2api) | 提供账号管理与共享的订阅中转服务，文档中的技术栈包含 PostgreSQL 和 Redis | 使用 Node.js 和本地文件完成个人切换，无需部署数据库、缓存或 Web 管理面板。 |
| [New API](https://github.com/QuantumNous/new-api) | 统一模型聚合、分发与协议转换平台 | 将已有的 Responses 兼容服务直接接入 Codex 工作流，减少个人用户配置完整分发平台的步骤。 |

easy-switch 将账号配置、路由选择、模型设置与备用排序集中在托盘应用或命令行接口中，降低个人用户的配置与运维步骤。其差异主要体现在部署方式与交互设计；请求级热切换本身并非本项目独有的机制。

<a id="faq"></a>

## ❓ FAQ

### 是否考虑引入其他 AI 服务商？

目前已可通过 `switch add api` 接入 OpenAI 官方 API 及兼容 Responses API 的第三方服务。Claude、Gemini 等原生订阅登录尚未实现。扩展服务商是可考虑的方向，但暂无确定发布时间，需要先完成认证、协议和工具调用兼容性适配。

### 是否考虑适配其他系统？

现已提供 Windows x64、macOS Apple 芯片及 Intel 的桌面安装包，同时保留 Linux systemd 命令行安装方式。桌面版仅在应用运行期间接管路由，Linux 版由 systemd 服务管理。Apple 芯片 macOS 已完成打包程序测试，Windows 和 Intel macOS 仍需原生运行验证。详见[桌面版指南](desktop.md)。

### 切换后，当前任务会中断吗？

手动切换对同一会话的后续模型请求生效；符合条件的上游拒绝可在成功响应流开始前通过备用服务重试。响应中途断流、上下文格式不兼容或全部备用不可用时，任务仍可能中断，不能保证所有故障都无感恢复。

<a id="disclaimer"></a>

## ⚠️ 免责声明

easy-switch 是独立社区项目，与 OpenAI 无隶属关系，也未获得其背书。请仅使用你有权访问的账号和 API，并遵守对应服务商的条款。切换上游会将所需的会话历史发送给选中的服务商。凭据保存在本地，并通过文件权限保护。

本项目处于实验阶段。已通过真实 Codex 进程与模拟上游验证同会话切换；真实服务商访问、VS Code Remote 界面及服务器重启恢复仍需端到端验证。部署前请阅读完整[免责声明](DISCLAIMER.md)与[运行限制](usage.md#protocol-support-and-limits)。

<a id="contributing"></a>

## 🤝 参与贡献

欢迎提交问题报告、兼容性验证结果、文档改进和范围集中的 Pull Request。报告问题时，请附上复现步骤与运行环境，并移除日志中的凭据和私人会话内容。

开发环境与贡献流程见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

<a id="license"></a>

## 📄 许可证

[MIT](LICENSE) © 2026 easy-switch contributors。
