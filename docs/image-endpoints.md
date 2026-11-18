# Desktop image endpoint verification

Verified on November 18, 2026 with the locally installed official desktop app 26.1111.21308. These are observed implementation details, not a documented public API contract. No changes were made to the running official app or its login.

## What the integrated Images page establishes

The Images page is part of the integrated ChatGPT surface. Its image permission check does not simply exclude personal Free accounts. Loading the page or its templates does not establish permission to complete an image request.

The renderer reads `/images/init` and `/images/styles` through a ChatGPT backend request bridge. The main process obtains the existing account token from app-server `getAuthStatus`, attaches bearer authentication and the account ID, and refreshes on HTTP 401. No separate browser cookie is inherently required for these backend requests.

The image composer uses the `picture_v2` system hint and the ChatGPT conversation pipeline, including `/f/conversation/prepare` and streaming `/f/conversation`. That pipeline also handles request-integrity challenges and asynchronous image assets. The new `AccountImages` adapter runs that official page with the saved account identity, without independent browser sign-in. Live page generation and editing have been verified using a paid account; the same adapter has not yet been tested with a currently Free account.

The client additionally contains a narrower image API used by Library note drawings: `/wham/images/generations` and `/wham/images/edits`. This is a separate finding from the Images page’s conversation route. Both accept JSON and return image data in the native Images response format. easy-switch keeps this fast direct route before the page adapter. The app’s private JavaScript and challenge machinery are not copied into the project; the official page performs its own request validation.

## Live checks

Tests used an already-saved account token, without preexisting login cookies, another login or a visible browser window. The account’s live usage response identified a paid `prolite` plan.

| Request | Result | Scope |
| --- | --- | --- |
| `GET /backend-api/images/init` | HTTP 200 | Image catalog authentication |
| `GET /backend-api/images/styles` | HTTP 200 | Image style catalog authentication |
| `GET /backend-api/models` | HTTP 200 | ChatGPT model catalog authentication |
| `POST /backend-api/conversation/init` with `picture_v2` | HTTP 200 | Image-composer initialization with existing OAuth; this is not a completed generation |
| Minimal `POST /backend-api/f/conversation` without the native integrity flow | HTTP 403 | Service reported unusual device activity; no image returned. No attempt was made to bypass that rejection |
| `POST /backend-api/wham/images/generations` | HTTP 200, actual image bytes | Paid-account generation |
| `POST /backend-api/wham/images/edits` | HTTP 200, actual image bytes | Paid-account reference editing; model, quality, size and background fields accepted |
| Isolated real Codex → easy-switch → desktop image API | Completed | Native route rejection simulated locally; desktop generation live, about 7 seconds; native image tool returned and task continued; text upstream simulated locally |
| Isolated real Codex reference edit → desktop image API | Completed | Native route rejection simulated locally; edit live, about 9 seconds; nonempty image result returned to the native tool and task continued |
| Empty browser partition → saved account bootstrap → official Images page | Completed | No login cookies or manual image sign-in; live image returned; hidden page and storage released |
| Real Codex → saved-account Images page → native tool result | Completed | Direct endpoint rejections simulated; live page generated a nonempty image and continued the task, about 18 seconds |
| Real Codex reference edit → saved-account Images page | Completed | Direct endpoint rejections simulated; live reference upload/edit returned a nonempty image, about 24 seconds |
| Text after account-page image quota failure | Completed | Image quota response simulated; same Codex thread continued on the selected API and could switch APIs |

Direct-endpoint Codex tests retained the selected text API and made no webpage calls. Page-route Codex tests used an invisible temporary page with saved OAuth and an empty browser profile. Neither installed a native Codex authentication file. Observed timings are not latency guarantees.

**Free authorization on the new saved-account page adapter and desktop image API remains unverified.** Earlier Free-account success used the separate webpage login. An earlier direct Free request to the Codex image endpoint returned HTTP 403. These findings cannot be combined into a claim that the new routes have been verified for Free.

## Routing boundary

1. Try the saved account’s Codex image endpoint normally.
2. For a JSON request with an eligible HTTP endpoint/entitlement rejection, try the matching desktop image endpoint once, retaining the same account and image parameters.
3. On desktop, an eligible availability rejection can automatically initialize the official Images page with this same saved identity. No settings switch or independent login is needed.
4. Continue eligible image rejections to the other saved providers. Uncertain already-submitted page jobs are not replayed.

Quota, authentication, content policy, ordinary validation and uncertain transport failures do not trigger steps 2 or 3 on the same account. Already accepted output is not replayed. Text routing, provider order and native account identity remain independent of image routing. The independent browser-login panel and persistent image profile are no longer used. See [automatic account images](account-images.md).
