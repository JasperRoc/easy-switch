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

This starts a real app-server with a temporary `CODEX_HOME`, reads the installed provider configuration, and completes three turns in the same thread/process through local mock upstreams. It verifies manual switching, then an HTTP 403 quota rejection followed by transparent fallback with identical conversation input. The default test command skips this opt-in test.

GitHub Actions defines a Node.js 22/24 matrix across Linux, macOS, and Windows. Configuration of a CI matrix is not evidence that each platform has passed. The installer targets Linux systemd even though core tests are cross-platform.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for pull request guidelines.

## Publish to GitHub

GitHub hosts the source and CI; the proxy runs on the user's server, not GitHub Pages. Create an empty repository and replace the remote below:

```bash
git init -b main
git add .
git commit -m "Initial easy-switch release"
git remote add origin https://github.com/<owner>/<repository>.git
git push -u origin main
```

Review staged files before committing. Do not include real authentication caches, API keys, device codes, or unredacted configurations. `private: true` prevents accidental npm publication but still permits installation from source.

The project uses the [MIT License](LICENSE). English and Simplified Chinese READMEs, the license, contribution guide, disclaimer, and operations documentation are included in the package file list.
