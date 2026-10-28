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
SWITCH_TEST_CODEX="$(command -v codex)" node --test test/codex.integration.test.js
```

This starts a real app-server with a temporary `CODEX_HOME`, reads the installed provider configuration, and completes turns in the same thread/process through local mock upstreams. It verifies manual switching, an HTTP 403 quota rejection followed by transparent fallback with identical conversation input, and model/effort switching within one active turn. The latter emits a real shell tool call, changes the selection while its response is streaming, and checks that Codex executes the tool and continues on the new model without a second user turn. The default test command skips this opt-in test.

The shell installer targets Linux systemd. The desktop build targets Windows and macOS. Run the checks above locally before submitting changes.

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

The preparation script downloads the matching pinned official Codex platform package through npm, extracts only the executable used for login/catalog discovery, and includes its Apache-2.0 license. Build output goes to ignored `dist/`; helper downloads go to ignored `.desktop-cache/`. macOS builds require macOS. Windows NSIS installers can be cross-built on macOS. Desktop packages include their runtime dependencies and require no npm setup on the user's computer. The CLI npm package excludes desktop build tools and bundled executables.

`electron-builder.yml` uses ad hoc macOS signing (`identity: "-"`) with minimal JIT/library-validation entitlements. `scripts/verify-mac.cjs` runs after signing and fails packaging if the app or bundled Codex signature is invalid. Ad hoc signing is not Developer ID signing or Apple notarization; Gatekeeper approval can still be required. Windows packages have no publisher signature. For a trusted public distribution, configure publisher certificates and notarization credentials and adjust signing settings; never commit those credentials.

After building, verify the actual DMGs before publishing:

```bash
node scripts/verify-mac-artifacts.cjs dist/easy-switch-0.3.1-mac-arm64.dmg dist/easy-switch-0.3.1-mac-x64.dmg
```

This checks image checksums, mounts each image read-only without opening Finder, verifies the contained application/nested code, and detaches it. A successful `codesign` result does not mean `spctl` will trust an unnotarized ad hoc application.

The editable logo lives in `desktop/assets/icon.svg`. Run `npm run desktop:icons` to render packager PNGs and the macOS template icon at 1×/2×. The background tile has standard transparent padding, so its visual size fits other macOS icons. `desktop/i18n.js` holds paired English/Chinese strings used by both the renderer and main-process tray menus. Theme and language preferences live in `desktop.json`; appearance tests verify live changes and restart persistence.

Run real Electron integration tests after preparing the native helper:

```bash
npm run desktop:prepare
SWITCH_TEST_DESKTOP=1 node --test test/desktop.integration.test.js
```

On Windows PowerShell, set `$env:SWITCH_TEST_DESKTOP='1'` before the Node command. To test a packaged application, also set `SWITCH_TEST_DESKTOP_EXE` to its executable path. Tests isolate configuration/credentials with temporary `SWITCH_HOME` and `CODEX_HOME`, do not change login items, and do not make paid model requests. They verify the bundled native model catalog, API setup, model/effort selection, tray lifetime, restoration on exit and independent recovery after a forced main-process crash. Test screenshots are written to ignored `.desktop-test/`.

`desktop/main.cjs` owns Electron's tray/window and a narrow IPC interface; `preload.cjs` exposes only approved actions. `controller.js` connects those actions to the shared provider/model/auth core. `runtime.js` manages proxy lifetime and the independent recovery helper, while `config.js` records and restores configuration without discarding unrelated edits. The static renderer has no Node.js access. See [desktop.md](desktop.md) for runtime limits and recovery instructions.
