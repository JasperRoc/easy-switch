# Desktop image endpoint verification

Verified on November 18, 2026 with the locally installed official desktop app 26.1111.21308. These are observed implementation details, not a documented public API contract. No changes were made to the running official app or its login.

## What the integrated Images page establishes

The Images page is part of the integrated ChatGPT surface. Its image permission check does not simply exclude personal Free accounts. Loading the page or its templates does not establish permission to complete an image request.

The renderer reads `/images/init` and `/images/styles` through a ChatGPT backend request bridge. The main process obtains the existing account token from app-server `getAuthStatus`, attaches bearer authentication and the account ID, and refreshes on HTTP 401. No separate browser cookie is inherently required for these backend requests.

The image composer uses the `picture_v2` system hint and the ChatGPT conversation pipeline, including `/f/conversation/prepare` and streaming `/f/conversation`. That pipeline also handles request-integrity challenges and asynchronous image assets. Its complete live Free-account generation flow has not been captured or implemented here.

The client additionally contains a narrower image API used by Library note drawings: `/wham/images/generations` and `/wham/images/edits`. This is a separate finding from the Images page’s conversation route. Both accept JSON and return image data in the native Images response format. This narrower route is the one added to easy-switch; the app’s private JavaScript and challenge machinery are not copied into the project.

## Live checks

Tests used an already-saved account token, without cookies, another login or a browser window. The account’s live usage response identified a paid `prolite` plan.

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

The Codex test retained the selected API for text, made no webpage calls and created no native Codex authentication file. It does not establish a latency guarantee.

**Free authorization on the desktop image API remains unverified.** Earlier Free-account success used the separate webpage adapter. An earlier direct Free request to the Codex image endpoint returned HTTP 403. These findings cannot be combined into a claim that the desktop image API has been verified for Free.

## Routing boundary

1. Try the saved account’s Codex image endpoint normally.
2. For a JSON request with an eligible HTTP endpoint/entitlement rejection, try the matching desktop image endpoint once, retaining the same account and image parameters.
3. Continue to other saved accounts/APIs on an eligible rejection, following the existing image priority queue.
4. Use the independent webpage adapter only if explicitly enabled and eligible direct routes are exhausted.

Quota, authentication, content policy, ordinary validation and uncertain transport failures do not trigger step 2. Already accepted output is not replayed. Text routing, provider order and native account identity remain independent of image routing.
