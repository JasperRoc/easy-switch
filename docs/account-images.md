# Images in Codex / 在 Codex 中生图

**Keep the conversation. Ask for an image.** / **在当前对话里，直接说出你想要的画面。**

1. Add a ChatGPT account in fluid. / 添加 ChatGPT 账号。
2. Restart an already-open Codex once to refresh its tools. / 首次配置后重启已打开的 Codex，刷新工具列表。
3. Ask Codex to generate or edit an image. Text keeps its selected provider. / 在对话中请求生图或改图，文字请求继续使用原服务商。

The router tries eligible image accounts before output starts. When a direct endpoint rejects access, the adapter can use the same saved account through an isolated official image-page session. Free accounts are supported when their actual image access and quota allow it; no paid plan is fabricated. / 路由在输出前尝试可用图片账号；直连接口拒绝时，可复用同一账号，通过隔离的官方图片页面适配。Free 是否可用取决于实际图片权限与额度，不伪装付费身份。

Chrome or Edge is needed for the page fallback. The browser is headless, uses a temporary profile and is removed after the job; normal use does not require a second website login. Initial page bootstrap can be slower than a direct request. Official anti-abuse checks, outages and quota can still reject a job. / 页面适配需要 Chrome／Edge，使用无界面的临时环境并在结束后清理，正常使用无需再次登录网页；首次页面初始化可能较慢，官方验证、服务异常和额度仍可能阻止请求。

If a request fails, check the account quota and error category. Repeatedly retrying cannot grant missing permission or restore exhausted quota. / 失败时查看账号额度和错误类别，反复重试不能绕过权限或额度限制。
