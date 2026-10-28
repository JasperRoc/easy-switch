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

The installer targets Linux systemd. Run the checks above locally before submitting changes.

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


## Desktop lifecycle requirements (planned)

Windows/macOS GUI support is not implemented in this release. Its lifecycle must be application-scoped: installation alone does not enable routing, starting the application backs up and activates its connection settings, and exiting restores the user's configuration. Login startup is an explicit user choice. Closing a settings window may leave the application running in the tray; quitting the application ends routing.

Restoration must preserve unrelated user edits and provide recovery after an abnormal exit. Existing Codex clients can cache their endpoint, so desktop acceptance tests must cover clients still pointing at the local proxy during shutdown; restoring a file alone is not evidence that those clients can continue. The existing Linux systemd lifecycle remains independent of this planned desktop behavior.
