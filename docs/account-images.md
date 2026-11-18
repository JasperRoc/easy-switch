# Automatic account images

Desktop image routing reuses accounts already added to easy-switch. The independent webpage-login panel and its switch have been removed. Users do not need to log in a second time, open an image window, or maintain another browser profile.

## Routing

1. Keep the desired text provider selected and ask Codex to generate or edit an image.
2. Available saved accounts are tried in image priority order. Direct Codex image endpoints remain first; an eligible JSON rejection can try the matching desktop image endpoint.
3. If an account's direct image endpoints explicitly reject availability, desktop can initialize a temporary ChatGPT Images session with the same real saved OAuth identity. The official page sends the request and handles integrity verification; the official service decides permission and quota.
4. Eligible rejections can continue through other configured image providers. Text selection is independent. A successful direct image request never loads the page.

There is no Free-plan exclusion or paid-plan override. An account that cannot generate images is not granted that permission by the adapter. Live generation, reference-image editing, native Codex tool return, provider switching and continued text after a simulated image-quota failure have been verified with a paid account. Current Free authorization remains unverified. Earlier independent-browser Free results do not establish the new route's Free behavior.

## Lifecycle and limits

Each page job starts in an empty, nonpersistent browser partition without sign-in cookies. It uses the existing account token only for the official image page and its exact-origin session bootstrap. Other page requests use official network and validation flows. The browser is sandboxed and has no Node.js or app UI bridge. Windows stay hidden and are destroyed after each job; temporary uploads and browser storage are cleared. No browser exists while idle.

The page creates a regular ChatGPT conversation. Its service chooses image model, quality and dimensions. Page fallback supports one image per request and up to five inline PNG/JPEG/WebP/GIF references, each at most 24 MiB. Masks, markup, SVG and animation are unsupported. Direct endpoints retain native request parameters.

Policy refusals, ordinary validation errors, authentication failures, quota failures and uncertain direct transport failures do not start the same-account page route. The adapter does not manufacture verification tokens or alter account claims. Once a page request is submitted, an uncertain timeout or lost result is not replayed on another account. A bounded cache keyed by account, turn ID and body avoids repeated submissions on native retries.

Image errors remain image-tool results. Image quota exhaustion does not replace the selected text API or install a subscription as Codex's active identity. Expired saved-account authentication is handled through that account's existing login workflow, without a separate image sign-in.

Reload an already-running Codex once if it has not registered the image tool. Later provider switches preserve the tool. See [image routing](usage.md#image-generation-routing) and [verification](image-endpoints.md).

## 简体中文

图片直接复用 easy-switch 中已添加的账号，无需额外网页登录、设置开关或手动打开窗口。优先原生直连接口；账号接口明确不可用时，自动用同一真实账号建立临时后台「图像」会话，由官方页面和服务端处理验证、权限及额度。

每次使用全新的非持久化分区，不读取用户浏览器 Cookie，不改写套餐，不改变 Codex 当前登录身份。后台页面结束后销毁并清理临时上传及浏览器状态；没有请求时不运行浏览器。页面生成会创建普通 ChatGPT 会话，模型、质量和尺寸由页面服务决定。图片失败不影响当前文字服务商，已提交但结果不明的图片不会换账号重复生成。

已完成付费账号的真实出图、参考图编辑、Codex 工具结果回传及模拟图片额度耗尽后的文字续接验证；尚未验证当前 Free 账号在此新适配器中的实际授权。软件不会在本地排除 Free，最终权限由官方服务决定。
