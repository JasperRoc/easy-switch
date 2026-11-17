# Optional ChatGPT web image fallback

Desktop 0.5.26 added an optional, experimental browser adapter for Codex's built-in image tool. ChatGPT web sign-in stays in a separate browser profile while Codex remains connected to the easy-switch gateway. A Free account was used to verify live generation, reference-image editing, native Codex image output, and continued text in the same task after a real zero-image quota rejection. This does not guarantee access for every account or future webpage versions.

## Routing and sign-in boundaries

Saved Codex subscriptions and APIs each enable the native image tool without requiring the web fallback. They are always tried before the optional webpage, even when the web switch is enabled. A successful native account request uses the account credentials already stored by easy-switch, without a second login or browser window. Native image entitlement, authentication, quota, missing-endpoint or eligible transient failures can try other saved providers; only after that queue is exhausted can this enabled web fallback run. Content-policy refusals and unrelated validation errors do not fall back to the webpage.

The web adapter is not a token converter. Codex OAuth credentials do not supply the independent browser session cookie. Official [Codex pricing](https://learn.chatgpt.com/docs/pricing#image-generation-usage-limits) currently excludes Free image generation; web image access is separate. The [Sign in with ChatGPT preview restrictions](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) concern hosted Responses tools, not every native Codex image tool path. A missing local tool and an HTTP denial at the image backend are different failures. Merely enabling a tool does not grant image entitlement.

## Setup

1. Open **Settings → ChatGPT web image fallback · experimental** and choose **Open image sign-in**.
2. Complete normal ChatGPT sign-in in the independent image window, using the account that provides web image access.
3. Enable the web image switch. Reload an already-running Codex client once so it registers the image tool.
4. Keep the desired text provider selected and ask Codex to generate or edit an image. Native saved accounts/APIs are tried first. Only eligible failures reach the optional webpage; text requests keep the selected API or subscription.

Native account/API image routes remain active regardless of this switch. Turn it off to disable only the web fallback. **Clear image sign-in** clears this browser profile's cookies and storage. It does not log Codex out or change the current text provider. The adapter does not restore the official app's sidebar image page and does not add a new `switch model` command.

## Request flow

The adapter opens the normal ChatGPT Images page, enters the image prompt using native browser input and clicks the page's send button. For edits, it uploads inline reference images through the file-upload control. It reads a completed generated image, validates the downloaded bytes and returns native Images JSON to Codex. Codex then handles the image result and resumes its task normally.

The adapter does not directly call private web conversation endpoints, read existing browser cookies, or manufacture verification tokens. Image generation never calls `show()` or `focus()` on the browser. Sign-in, verification, quota errors and timeouts remain in the tool result and Settings status; only the explicit Open image sign-in action opens the page. Hidden windows are destroyed after success or failure. If the web session expires, the user must open it manually; no automatic sign-in is attempted.

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
- DOM selectors depend on the ChatGPT page. Page changes, sign-in provider restrictions, output/download failures and unavailable account access can interrupt a request. An attention state lets the user explicitly reopen the webpage from Settings without changing the text route.
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

在 **设置 → ChatGPT 网页图片备用 · 实验性** 中打开图片登录，完成官方登录后开启开关。已运行的 Codex 首次需要重载一次来注册图片工具。文字保持所选服务商，内置图片请求优先尝试已保存订阅账号和 API；只有符合条件的失败且原生备用耗尽后才尝试网页。原生账号／API 图片路径使用现有凭据，无需重新登录。关闭开关只禁用网页备用；“清除图片登录”只清理此独立网页环境，不改变 Codex 登录或文字服务商。此功能不恢复官方客户端侧栏页面。

适配操作正常网页输入框、上传控件及发送按钮，再将生成结果转换为 Codex 图片结果，不直接调用私有会话端点，不读取用户现有浏览器 Cookie，不自行构造验证令牌。生成期间不自动打开窗口；登录、验证、额度错误和超时通过工具结果及设置状态提示。只有用户主动点击打开图片登录时显示网页，隐藏窗口在请求完成或失败后销毁。Codex OAuth 不等于网页登录 Cookie，无法凭现有 Codex 令牌保证免登网页。

**图片请求会在该 ChatGPT 账号中创建普通聊天和附件，并可能出现在历史记录。** 实测临时聊天拒绝图片生成，因此不使用临时聊天；数据保留遵循账号自身设置，easy-switch 不自动删除这些聊天。

图片额度、登录或内容限制只影响图片工具，文字凭据、优先级和当前服务商不变。已提交请求不自动重放；同一图片 turn ID 与请求体的原生客户端重试会复用短期内存结果，成功最多保留 10 分钟、失败 1 分钟，登录及并发错误除外；缓存最多 2 条，降低重复生成风险。取消本地等待不能保证上游停止生成或消耗额度。

独立持久化分区位于 `SWITCH_HOME/desktop-ui/Partitions/easy-switch-web-images`，处于 Electron 用户数据目录内，确保网络沙箱可以写入 Cookie 数据库。正常退出和更新前写入登录状态，重启复用持久 Cookie；会话 Cookie、被官方撤销或失效的登录仍需认证。普通界面仅收到开关与阶段，不收到登录令牌。清除登录删除独立网页存储，彻底卸载删除目录。

支持单个图片请求和最多 5 张内联 PNG/JPEG/WebP/GIF 参考图，每张最多 24 MiB，仍受本地请求体总计 32 MiB 限制。远程 URL、文件 ID、蒙版、动画、SVG 及多图数量控制暂不支持。模型、质量和尺寸由 ChatGPT 网页决定；生成式编辑可能改变风格或其他细节，不能保证精确保留。

浏览器按需创建，隐藏窗口在成功或失败后销毁，空闲不轮询；生成期间最多每 1.5 秒检查进度，最多等 10 分钟，不阻止系统休眠。网页结构或权限变化可能导致失败，需要时由用户主动打开窗口查看。当前不支持无界面的 Linux 服务；Windows 仍需原生系统验证。

2026 年 11 月 15–16 日的真实验证覆盖了 Free 网页生成、添加云朵的参考图编辑、真实 Codex 的图片工具调用和原任务续接，以及真实零图片额度时仍可继续文字并切换 API。文字上游使用本地模拟服务，图片上游为实际 ChatGPT 网页；不将账号、私有聊天或生成图片提交为测试数据。

On November 17, 2026, a real Codex app-server completed native image generation and continued the same turn through easy-switch in about eight seconds (one observation, not a speed guarantee). The text upstream was simulated and the image upstream was live; no web handler was called or native auth file created. A separate direct native image request using an existing paid Codex account returned HTTP 200 with image data and no webpage. This validates that account's native route; it does not establish native Free entitlement. The Free web checks above still required a separate browser sign-in.

2026 年 11 月 17 日补测：真实 Codex 通过 easy-switch 使用已保存付费账号调用原生图片接口，并在同一任务内继续文字，本次约 8 秒完成（单次观测，不是速度保证），网页调用为 0，也未创建原生登录文件。文字上游为模拟服务，图片上游为真实接口；另一次直接图片请求也返回 HTTP 200 和图片数据。该结果只验证该账号原生权限，不能据此宣称 Free 原生图片免登可用；前述 Free 网页验证使用的是独立网页登录。
