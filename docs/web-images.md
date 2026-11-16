# Isolated ChatGPT web images

Desktop 0.5.26 adds an optional, experimental browser adapter for Codex's built-in image tool. ChatGPT web sign-in stays in a separate browser profile while Codex remains connected to the easy-switch gateway. A Free account was used to verify live generation, reference-image editing, native Codex image output, and continued text in the same task after a real zero-image quota rejection. This does not guarantee access for every account or future webpage versions.

## Setup

1. Open **Settings → ChatGPT web images · experimental** and choose **Open image sign-in**.
2. Complete normal ChatGPT sign-in in the independent image window, using the account that provides web image access.
3. Enable the web image switch. Reload an already-running Codex client once so it registers the image tool.
4. Keep the desired text provider selected and ask Codex to generate or edit an image. Subsequent native image requests use the independent webpage while text requests keep the selected API or subscription.

To use the existing native account/API image routes again, turn off this switch. **Clear image sign-in** clears this browser profile's cookies and storage. It does not log Codex out or change the current text provider. The adapter does not restore the official app's sidebar image page and does not add a new `switch model` command.

## Request flow

The adapter opens the normal ChatGPT Images page, enters the image prompt using native browser input and clicks the page's send button. For edits, it uploads inline reference images through the file-upload control. It reads a completed generated image, validates the downloaded bytes and returns native Images JSON to Codex. Codex then handles the image result and resumes its task normally.

The adapter does not directly call private web conversation endpoints, read existing browser cookies, or manufacture verification tokens. Required sign-in and verification are shown in the normal webpage for the user to complete.

**Image requests create regular conversations and attachments in the selected ChatGPT account.** They can appear in its history. The earlier temporary-chat path was rejected by the live page and is not used. Follow that account's retention and privacy settings; easy-switch does not delete these conversations automatically.

Image quota, authentication errors and content refusals affect only the image route. Text credentials, provider priority and global text selection stay unchanged. Once submitted, a request is not automatically replayed. Native transport retries with the same image-turn ID and body reuse a bounded in-memory result for up to ten minutes; failed requests are retained for one minute, excluding sign-in and concurrency errors. The cache holds at most two entries. This reduces duplicate generation when the native client retries a completed or rejected request. A different prompt or turn can generate normally.

Cancellation closes the local browser page and removes temporary upload files; it does not guarantee that the server stops generating or consuming quota. No operation disables official image limits or content restrictions.

## Login storage and activity

The browser uses the persistent partition `persist:easy-switch-web-images` under `SWITCH_HOME/desktop-ui/Partitions/easy-switch-web-images` on standard desktop installs. It stays within Electron's session-data directory so the sandboxed network process can write its cookie database. Sign-in storage is flushed before normal application exit and update; ordinary restart reuses saved persistent cookies. Session-only cookies and server-revoked logins can still require authentication.

Codex's native `auth.json` and OS keychain login are left untouched. The app's normal renderer receives only the route's enabled flag and phase, not cookies or tokens. Complete uninstall removes the browser profile along with other easy-switch data.

The browser is created on demand. A completed hidden image window is destroyed; idle visible windows use background throttling. There is no idle browser polling. While generation is active, the adapter checks progress at most every 1.5 seconds and waits up to ten minutes. It does not prevent system sleep.

## Current limits

- One image request at a time; generation and up to five inline PNG/JPEG/WebP/GIF references, at most 24 MiB per file, within the existing 32 MiB proxy-body limit.
- Remote reference URLs, file IDs, masks, SVG/animation controls and multiple-image count requests are rejected rather than silently dropped.
- ChatGPT web chooses the actual model, quality and dimensions. Images-model fields from Codex are not equivalent to selecting an exact web model. Transparent-background intent is included in the prompt and requires result validation.
- Editing is generative and can change details or style despite a preservation prompt. A valid returned image is not proof of exact visual preservation.
- DOM selectors depend on the ChatGPT page. Page changes, sign-in provider restrictions, output/download failures and unavailable account access can interrupt a request. An attention state lets the user inspect the webpage without changing the text route.
- The adapter is a desktop feature. Headless Linux service support is not implemented, and Windows runtime behavior still needs native hardware validation.

## Validation

```bash
npm run check
npm test
SWITCH_TEST_DESKTOP=1 node --test test/web-images.integration.test.js
SWITCH_TEST_CODEX="$(command -v codex)" node --test test/codex.integration.test.js
```

Default tests use temporary directories and simulated upstreams. Opt-in Chromium tests verify both legacy textareas and the current contenteditable page structure, Chinese send labels, generated-image galleries, reference uploads, quota errors, and login persistence across separate processes. The native Codex scenario verifies image output and text continuation after image-quota failure without a native subscription sign-in.

Separately, live checks on November 15–16, 2026 verified generation and an edited image with an added cloud through a Free ChatGPT web account. A real Codex app-server completed an image-tool call using live web output, continued the same task, and accepted a switch to another API. A later real zero-image quota rejection was returned by the image tool while text continued in the same task. Text inference in these live-image checks used local simulated upstreams, not paid provider inference. Account credentials, image outputs and private chats are not committed as test fixtures.

## 简体中文

桌面版 0.5.26 增加可选的实验性网页图片适配。图片使用独立的 ChatGPT 网页登录，Codex 仍以本地 easy-switch 网关身份连接。已使用 Free 网页账号验证真实图片生成、参考图编辑、Codex 工具结果回传，以及真实图片额度耗尽后的原任务文字续接；不保证所有账号或后续网页版本都可用。

在 **设置 → ChatGPT 网页图片 · 实验性** 中打开图片登录，完成官方登录后开启开关。已运行的 Codex 首次需要重载一次来注册图片工具。文字保持所选服务商，后续内置图片请求改由独立网页处理。关闭开关后恢复已有原生账号／API 图片路由；“清除图片登录”只清理此独立网页环境，不改变 Codex 登录或文字服务商。此功能不恢复官方客户端侧栏页面。

适配操作正常网页输入框、上传控件及发送按钮，再将生成结果转换为 Codex 图片结果，不直接调用私有会话端点，不读取用户现有浏览器 Cookie，不自行构造验证令牌。需要登录或验证时由用户在官方网页完成。

**图片请求会在该 ChatGPT 账号中创建普通聊天和附件，并可能出现在历史记录。** 实测临时聊天拒绝图片生成，因此不使用临时聊天；数据保留遵循账号自身设置，easy-switch 不自动删除这些聊天。

图片额度、登录或内容限制只影响图片工具，文字凭据、优先级和当前服务商不变。已提交请求不自动重放；同一图片 turn ID 与请求体的原生客户端重试会复用短期内存结果，成功最多保留 10 分钟、失败 1 分钟，登录及并发错误除外；缓存最多 2 条，降低重复生成风险。取消本地等待不能保证上游停止生成或消耗额度。

独立持久化分区位于 `SWITCH_HOME/desktop-ui/Partitions/easy-switch-web-images`，处于 Electron 用户数据目录内，确保网络沙箱可以写入 Cookie 数据库。正常退出和更新前写入登录状态，重启复用持久 Cookie；会话 Cookie、被官方撤销或失效的登录仍需认证。普通界面仅收到开关与阶段，不收到登录令牌。清除登录删除独立网页存储，彻底卸载删除目录。

支持单个图片请求和最多 5 张内联 PNG/JPEG/WebP/GIF 参考图，每张最多 24 MiB，仍受本地请求体总计 32 MiB 限制。远程 URL、文件 ID、蒙版、动画、SVG 及多图数量控制暂不支持。模型、质量和尺寸由 ChatGPT 网页决定；生成式编辑可能改变风格或其他细节，不能保证精确保留。

浏览器按需创建，隐藏窗口完成后销毁，空闲不轮询；生成期间最多每 1.5 秒检查进度，最多等 10 分钟，不阻止系统休眠。网页结构或权限变化可能导致失败，需要时可打开窗口查看。当前不支持无界面的 Linux 服务；Windows 仍需原生系统验证。

2026 年 11 月 15–16 日的真实验证覆盖了 Free 网页生成、添加云朵的参考图编辑、真实 Codex 的图片工具调用和原任务续接，以及真实零图片额度时仍可继续文字并切换 API。文字上游使用本地模拟服务，图片上游为实际 ChatGPT 网页；不将账号、私有聊天或生成图片提交为测试数据。
