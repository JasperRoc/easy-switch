# Development and publishing

[English README](../README.md) · [简体中文 README](README.zh-CN.md)

## Local checks

```bash
npm ci
npm run check
npm test
```

Default tests use mock upstreams and temporary directories. They cover request-boundary switching, streaming, credential isolation, reauthentication concurrency and failures, configuration recovery, CLI behavior, and systemd unit generation. They do not require real credentials or paid calls.

## Real Codex integration

With Codex installed:

```bash
SWITCH_TEST_CODEX="$(command -v codex)" node --test test/codex.integration.test.js test/task-sync.integration.test.js
```

This starts a real app-server with a temporary `CODEX_HOME` and completes turns in the same thread/process through local mock upstreams. It verifies manual switching, quota and model-access fallback with the original model/history, parallel tasks, a real shell-tool continuation, capacity recovery, cancellation and native image routing. Legacy easy-switch model overrides are tested separately to confirm they no longer alter client requests. The default command skips real-client integration tests.

The shell installer targets Linux systemd. The desktop build targets Windows and macOS. Run the checks above locally before submitting changes.

## Real Claude Code integration

```bash
SWITCH_TEST_CLAUDE="$(command -v claude)" node --test test/claude.integration.test.js
```

Runs the official client with an isolated `CLAUDE_CONFIG_DIR` against local mock upstreams. The test keeps one process and conversation open, switches APIs, and checks that the next message uses the new key with the original history. A second test makes the official client invoke its Agent tool and verifies a separate subagent model plus the parent tool-result continuation. A third test verifies all three Desktop model routes and context suffixes; a fourth switches models within one running conversation, retries Flash through a second provider after a simulated 429, and resumes that saved conversation in another process with the complete history and unchanged gateway settings. A fifth test reads the real CLI model menu, checks that subscription and three DeepSeek entries coexist, and selects independent Fable/Opus/Haiku mappings in one process. It makes no paid model calls. Subscription OAuth, refresh, header isolation, failover and settings restoration also have mock tests; live subscription inference requires a separately authorized account.

Claude support uses `src/claude-auth.js` for official sign-in and token refresh, `src/claude-config.js` for recoverable CLI settings, `src/claude-desktop.js` for separate Desktop profiles and discovery-backed model routes, and `src/claude-proxy.js` for shared Messages routing. State lives in `SWITCH_HOME/claude`; the existing listener dispatches `/claude/*` and `/claude-desktop/*` to the same provider state, credential and failover implementation. Both Claude discovery endpoints merge provider catalogs on demand, deduplicate original IDs and cache each provider for one minute, including failures, without background work. Both expose stable client-compatible route IDs with real names under the easy-switch gateway; only provider-specific catalog queries keep raw IDs. CLI settings enable gateway discovery and extend its timeout to accommodate upstream catalog reads, with restoration on stop. Partial discovery failures retain observed models while other providers remain usable. Provider/model cooldowns are independent, and a fallback is activated only after a valid response begins. Desktop distinguishes local authentication from upstream failures and reports the complete attempt chain. Explicit non-Claude selections retain their model across retries. Fable, Opus, Sonnet and Haiku selections apply each API’s independent family mapping on every attempt; subscription requests retain the original Claude ID. Family rules precede legacy defaults and agent-header mappings. Its startup profile contains no fixed model list. Explicit non-Claude catalog selections take priority over shared main/subagent defaults. Request lookup removes the client-only `[1m]` marker before resolving a catalog route; agent headers cannot override an explicit route. Non-Claude entries all have deterministic route IDs, avoiding published Claude names in the picker. Absent an explicit selection or mapping, Desktop uses the first catalog model. Provider model queries retain actual upstream IDs. The official-client test also checks the initialized CLI model menu for subscription and DeepSeek entries and verifies independent family selections in one process. Desktop setup is invoked by the desktop application, not the Linux CLI installer. Tests always isolate Desktop paths with a temporary `SWITCH_CLAUDE_DESKTOP_HOME` or injected directories and do not read personal Desktop settings.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for pull request guidelines.

## Publish to GitHub

GitHub hosts the source; the proxy runs on the user's server, not GitHub Pages. Create an empty repository and replace the remote below:

```bash
git init -b main
git add .
git commit -m "Initial easy-switch release"
git remote add origin https://github.com/<owner>/<repository>.git
git push -u origin main
```

Review staged files before committing. Do not include real authentication caches, API keys, device codes, or unredacted configurations. `private: true` prevents accidental npm publication but still permits installation from source.

The project uses the [MIT License](LICENSE). English and Simplified Chinese READMEs, the license, contribution guide, disclaimer, and operations documentation are included in the package file list.


## Desktop development and packaging

Use Node.js 22.12+ and run `npm ci`. Electron is a development dependency; Linux server installs use `--omit=dev` so they do not download the desktop toolchain.

```bash
npm run desktop:start
npm run desktop:build:mac
npm run desktop:build:win
```

The preparation script downloads the matching pinned official Codex platform package through npm, extracts only the executable used for login/catalog discovery, and includes its Apache-2.0 license and sanitized official model metadata for ordering/effort enrichment. The metadata never supplies available IDs; this avoids a second helper launch on Windows. Build output goes to ignored `dist/`; helper downloads go to ignored `.desktop-cache/`. macOS builds require macOS. Windows NSIS installers can be cross-built on macOS. Desktop packages include their runtime dependencies and require no npm setup on the user's computer. The CLI npm package excludes desktop build tools and bundled executables.

`electron-builder.yml` uses ad hoc macOS signing (`identity: "-"`) with minimal JIT/library-validation entitlements. `scripts/verify-mac.cjs` runs after signing and fails packaging if the app or bundled Codex signature is invalid. Ad hoc signing is not Developer ID signing or Apple notarization; Gatekeeper approval can still be required. Windows packages have no publisher signature. For a trusted public distribution, configure publisher certificates and notarization credentials and adjust signing settings; never commit those credentials.

After building, verify the actual DMGs before publishing:

```bash
node scripts/verify-mac-artifacts.cjs dist/easy-switch-0.5.6-mac-arm64.dmg dist/easy-switch-0.5.6-mac-x64.dmg
```

This checks image checksums, mounts each image read-only without opening Finder, verifies the contained application/nested code, and detaches it. A successful `codesign` result does not mean `spctl` will trust an unnotarized ad hoc application.

The editable logo lives in `desktop/assets/icon.svg`. Run `npm run desktop:icons` to render packager PNGs and the macOS template icon at 1×/2×. The background tile has standard transparent padding, so its visual size fits other macOS icons. `desktop/i18n.js` holds paired English/Chinese strings used by both the renderer and main-process tray menus. Theme and language preferences live in `desktop.json`; appearance tests verify live changes and restart persistence.

The Windows NSIS wizard uses that same approved logo, a pale ocean sidebar and a matching white header. `npm run desktop:installer-assets` regenerates its 24-bit BMP artwork from `scripts/installer-assets.cjs`; the Windows build runs it automatically. `desktop/assets/installer.nsh` sets Segoe UI typography and paired English/Simplified Chinese welcome/finish copy. Installer language follows Windows. Silent in-app updates skip the welcome page. Installation alone does not activate routing or enable startup at login.

Run real Electron integration tests after preparing the native helper:

```bash
npm run desktop:prepare
SWITCH_TEST_DESKTOP=1 node --test test/desktop.integration.test.js
```

On Windows PowerShell, set `$env:SWITCH_TEST_DESKTOP='1'` before the Node command. To test a packaged application, also set `SWITCH_TEST_DESKTOP_EXE` to its executable path. Tests isolate configuration/credentials with temporary `SWITCH_HOME` and `CODEX_HOME`, do not change login items, and do not make paid model requests. They verify provider-specific model lookup, API editing and Claude model mappings, quota-diamond tooltips, idle/background activity, tray lifetime, restoration on exit and independent recovery after a forced main-process crash. Test screenshots are written to ignored `.desktop-test/`.

`desktop/main.cjs` owns Electron's tray/window and a narrow IPC interface; `preload.cjs` exposes only approved actions. `controller.js` connects those actions to the shared provider/auth/catalog core. `runtime.js` manages proxy lifetime and the independent recovery helper, while `config.js` records and restores configuration without discarding unrelated edits. The static renderer has no Node.js access. See [desktop.md](desktop.md) for runtime limits and recovery instructions.

## Desktop UI and updater checks

The desktop renderer uses a small icon menu for language and appearance, native SVG symbols, a drag handle with keyboard fallback, and a separate provider deletion action. `DesktopUpdater` checks the official GitHub API before downloading anything. It requires the expected architecture asset, repository download URL, a SHA-256 digest, and a bounded package size. Downloads stream through a private partial file; macOS ZIP entries are checked for traversal, the bundle identifier/version are checked with PlistBuddy, and strict `codesign` verification runs before staging. The macOS helper waits for the old app to exit, atomically swaps the application, waits for the new startup receipt and restores the old bundle if startup fails.

Large desktop installers use four bounded HTTP range requests with completed-part receipts. Resumed files still need the full GitHub SHA-256 digest before installation. Servers that ignore Range use the single-stream verifier. macOS staging renames a same-volume app instead of recursively copying it; cross-volume updates copy and retain rollback behavior. Provider catalogs persist observed model metadata with hashed provider/credential fingerprints, are reused for up to 24 hours, and refresh in the background. A stale cache never establishes an inference model exclusion.

Windows updates copy `desktop/windows-update.ps1` into the private update cache and wait for a token-bound readiness file before quitting. The worker rechecks the downloaded hash, uses the cache as its native working directory, waits for the previous process and runs NSIS with an unquoted final `/D=<current installation>` argument. It observes the exit code and installed PE version, then explicitly launches the same executable and waits for its version/path/token-bound receipt. Failure keeps the installer and writes `last-error.txt`; background update checks leave that error visible. Versions before 0.5.37 need one manual installation over the existing directory to adopt this updater. `SWITCH_TEST_POWERSHELL=<pwsh executable> node --test test/windows-update.test.js` runs the worker with mocked installer/parent processes on macOS or Linux; Windows runs that test with its built-in PowerShell. These tests do not establish a real NSIS upgrade on Windows.

`desktop/uninstall.js` restores client recovery records before removing data, and `uninstall-cli.cjs` performs cleanup after Electron exits. macOS exposes complete removal in Settings; deleting an app bundle in Finder has no uninstall hook. Windows NSIS runs the headless cleanup on an actual uninstall and skips it during updates. Linux `switch uninstall` also removes managed completion blocks and its current-user package and private runtime. Original client credentials and conversation directories are outside the removal scope.

## Automatic account image routing

`desktop/account-images.js` implements a per-request, sandboxed ChatGPT Images session. The proxy supplies the saved account only after that account's direct endpoints explicitly reject availability. The page bootstrap receives the genuine OAuth identity and plan; exact-origin `/api/auth/session` requests read that same identity. Other network requests reach the official service normally, including request-integrity checks, permission checks and image quota. `desktop/web-image-page.js` only operates the composer, file inputs and bounded image downloads. The page has no Node.js bridge or app renderer IPC.

Partitions are nonpersistent and start without login cookies. Browser state and hidden windows are cleared after every success, failure or cancellation. An account-scoped bounded turn-result cache prevents duplicate page submissions. Uncertain submitted jobs do not retry on another provider. There is no image login, settings switch or public renderer authentication action. Text routing and native account identity remain separate.

```bash
SWITCH_TEST_DESKTOP=1 node --test test/account-images.integration.test.js
```

These tests use a real Chromium session, genuine bridge logic and simulated page generation/quota responses. They cover legacy and current composer forms, reference files, empty profiles and cleanup. Default tests never contact real account services. Live generation/edit checks used an existing paid account and local simulated text inference; the new page route has not yet been verified with a currently Free account. See [verification](image-endpoints.md). Credentials, conversations and generated image files are not committed.

## Selective Codex task sync

`src/task-sync.js` runs the selected-task synchronization loop and owns per-device selection, project mapping, revision checks, process locking and conflict choices. `src/sync-storage.js` provides encrypted packages and WebDAV requests; `src/sync-journal.js` stores immutable content-addressed revisions, detects divergent heads and retains conflict branches without relying on server compare-and-swap; `src/sync-server.js` is the optional SQLite storage server (Node.js 22.13+). `src/sync-codex.js` reads complete saved rollouts, relocates project/attachment paths, converts local compaction checkpoints and asks the official app-server to maintain its indexes and writer locks. `src/sync-project.js` creates Git bundles plus staged/unstaged/untracked changes, validates restores in disposable checkouts and protects divergent local work. `desktop/task-sync.js` supplies the bilingual settings page with separate Tasks/Storage tabs and a localized setup-guide link; the Linux daemon shares the same engine.

Ordinary/empty folders and Git repositories without a first commit use file snapshots. A private empty Git repository in the sync cache supplies ignore matching without initializing or changing the source folder; `.gitignore` plus dependency/environment exclusions apply. Incoming folder files are validated in a temporary directory before restoring, with conflict checks and recovery copies. The task list displays localized per-task errors below the folder path.

Codex runtime workspace roots in session metadata and saved thread settings are normalized to project-relative paths for hashing and relocated on import. Outside/ancestor roots are narrowed to the mapped project; an explicit empty list stays empty. Legacy hashes let an unchanged pre-0.5.38 local baseline remain recognizable. Foreign roots in existing selected histories are repaired with a backup and the official thread writer lock, using a local runtime-root override to acquire that lock. Real-client tests exercise new imports, unchanged legacy-copy repair, active-writer protection and continuation with both the pinned helper and current desktop CLI; path tests also cover Windows drives and UNC roots. They do not replace a real Windows execution test.

Default sync tests cover encryption, HTTP authorization, ETags, concurrent writes, attachment/checkpoint portability, Git/folder changes, path rejection, selection and conflicts. SQLite server tests require Node.js 22.13+ and skip on older supported clients. The opt-in real Codex tests use two isolated homes with both Git projects and ordinary folders, complete turns on both computers, verify the same task ID/history, and check that an open writer is never overwritten. Automated tests use no personal Codex history or paid inference. See [task-sync.md](task-sync.md) for configuration and explicit live-process limits.
