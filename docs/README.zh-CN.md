[English](../README.md) · **简体中文**

# easy-switch：更好的 AI 会话体验

![Node.js](https://img.shields.io/badge/Node.js-22%2B-417E38?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-Linux%20%2B%20systemd-2563EB?style=flat-square)
![Status](https://img.shields.io/badge/Status-Experimental-D97706?style=flat-square)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)

easy-switch 是面向 Codex 的命令行账号与 API 路由工具，统一管理 **ChatGPT 订阅账号、OpenAI 官方 API 与第三方兼容 API**。它在模型请求边界切换上游，保持客户端进程与会话连续；当上游返回符合条件的额度或认证错误时，按预设优先级尝试备用服务。

🔄 **会话内切换** · 🎛️ **交互式优先级管理** · ⚙️ **后台常驻与自动故障切换**

[快速开始](#quick-start) · [与现有工作的区别](#why-easy-switch) · [FAQ](#faq) · [免责声明](#disclaimer) · [参与贡献](#contributing) · [许可证](#license)

<a id="quick-start"></a>

## 🚀 快速开始

需要 **Linux + systemd/logind、Node.js 22+、npm、Git 和 Codex CLI**。请使用运行 Codex 或远程扩展的服务器账号安装。

### 1. 📦 克隆项目

```bash
git clone https://github.com/JasperRoc/easy-switch.git
cd easy-switch
```

### 2. ⚙️ 安装工具

```bash
./install.sh
```

安装器注册 `switch` 命令、启动 systemd 后台服务、启用开机启动，并备份和更新 Codex 配置。如果开机启动需要管理员协助，按安装器提示处理即可。首次安装后，重启 Codex 或重载远程编辑器窗口；之后切换上游无需重启。

### 3. ⌨️ 命令介绍

| 命令 | 作用 |
| --- | --- |
| `switch add account <alias>` | 添加订阅账号 |
| `switch add api <alias>` | 添加官方或第三方 API |
| `switch <alias>` | 切换后续请求使用的上游 |
| `switch list` | 查看备用优先级及当前上游（`*`） |
| `switch order` | 用键盘调整切换优先级 |
| `switch current` | 查看当前别名 |
| `switch service status` | 查看后台服务状态 |
| `switch service restart` | 重启服务，会中断进行中的请求 |
| `switch service uninstall` | 恢复配置并移除服务 |
| `switch help` | 查看命令帮助 |

添加 API 时，**Base URL 留空即使用 OpenAI 官方 API**（`https://api.openai.com/v1`），并填写对应的 OpenAI API Key；接入第三方服务时，填写其 Base URL 与 API Key。第三方地址不应附加 `/responses`，且需支持 Responses API、SSE 与 Codex 工具调用。

进入 `switch order` 后，用 **↑/↓** 选择，**Shift+↑/↓**（或大写 **K/J**）移动，**Enter** 保存，**Esc** 或 **Ctrl+C** 取消。优先级从上到下递减，保存顺序不会改变当前上游。

账号认证、数据存储和自动切换规则详见[运维指南](usage.md)。

<a id="why-easy-switch"></a>

## 🔎 与现有工作的区别

easy-switch 面向 Linux 服务器上的个人 Codex 工作流，重点解决账号与 API 切换时的会话连续性问题。其设计侧重于 **SSH 环境下的可操作性、较少的部署依赖，以及明确可控的故障切换顺序**。

| 项目 | 主要定位 | easy-switch 的适用优势 |
| --- | --- | --- |
| [CC Switch](https://github.com/farion1231/cc-switch) | 面向多种 AI 工具的桌面管理应用，支持本地路由和自动故障切换 | 全程通过 SSH 终端管理账号和优先级，由 systemd 独立运行，适合没有桌面环境的服务器。 |
| [Sub2API](https://github.com/Wei-Shaw/sub2api) | 提供账号管理与共享的订阅中转服务，文档中的技术栈包含 PostgreSQL 和 Redis | 使用 Node.js 和本地文件完成个人切换，无需部署数据库、缓存或 Web 管理面板。 |
| [New API](https://github.com/QuantumNous/new-api) | 统一模型聚合、分发与协议转换平台 | 将已有的 Responses 兼容服务直接接入 Codex 工作流，减少个人用户配置完整分发平台的步骤。 |

easy-switch 将账号配置、路由选择与备用排序集中在同一命令行接口中，降低个人用户的配置与运维步骤。其差异主要体现在部署方式与交互设计；请求级热切换本身并非本项目独有的机制。

<a id="faq"></a>

## ❓ FAQ

### 是否考虑引入其他 AI 服务商？

目前已可通过 `switch add api` 接入 OpenAI 官方 API 及兼容 Responses API 的第三方服务。Claude、Gemini 等原生订阅登录尚未实现。扩展服务商是可考虑的方向，但暂无确定发布时间，需要先完成认证、协议和工具调用兼容性适配。

### 是否考虑适配其他系统？

当前正式支持的安装目标是采用 systemd 的 Linux。macOS 和 Windows 的原生后台服务安装可作为后续扩展方向，暂无确定排期。核心测试可以跨平台运行，不代表这些平台已经支持完整安装。

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
