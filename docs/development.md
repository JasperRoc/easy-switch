# Development

## Run & test

Use Node.js 22.18+, Rust 1.100 and the platform build tools.

```bash
npm ci
npm run check
npm test
npm run desktop:start
```

Default tests use isolated homes and mock upstreams. Never install the Linux service just to run tests. Opt-in checks use your installed client with local fixtures:

```bash
SWITCH_TEST_CODEX="$(command -v codex)" npm test -- test/codex.integration.test.ts
SWITCH_TEST_CODEX="$(command -v codex)" npm test -- test/task-sync.integration.test.ts
SWITCH_TEST_IMAGE_BROWSER=1 npm test -- test/account-images.integration.test.ts
```

## Project map

| Path | Purpose |
| --- | --- |
| `rust/desktop/src` | Native gateway, stream handling, tray, lifecycle and updates |
| `desktop` | TypeScript WebView UI, account login and desktop integrations |
| `src` | CLI, provider config, session sync, Skills, MCP and usage |
| `test` | TypeScript regressions and isolated protocol fixtures |
| `scripts` | TypeScript build, packaging and verification tools |
| `docs` | User guides, screenshots, licenses and release notes |

Generated JavaScript and packages stay in ignored `.build/` and `dist/`. GitHub reports the source languages; no source files are relabeled to manufacture percentages.

## Build a package

```bash
npm run desktop:build:mac -- arm64
npm run desktop:build:mac -- x64
npm run desktop:build:win
```

Build on the target OS. Linux: `cargo build --release --locked --manifest-path rust/desktop/Cargo.toml`. Artifacts go to `dist/native-<version>/`. The public CLI is `fd`; the private desktop/gateway executable is `fluid`.

The release workflow runs only on version tags or manual dispatch. It checks five targets and publishes packages with SHA-256 hashes after all builds pass. It does not rebuild every main-branch push. Never publish artifacts from a different commit.

## macOS signing

Ad hoc previews require first-launch approval. For trusted public distribution, configure GitHub secrets:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64 `.p12` with Developer ID Application certificate and private key |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` password |
| `APPLE_SIGNING_IDENTITY` | Exact Developer ID Application identity |
| `APPLE_ID` | Apple account |
| `APPLE_PASSWORD` | Apple app-specific password |
| `APPLE_TEAM_ID` | Developer team ID |

The runner imports a temporary keychain, signs the private Node runtime, signs/notarizes the app and checks the stapled ticket plus Gatekeeper. Empty secrets produce an explicit preview. Configured signed releases fail if notarization cannot be verified. Never commit credentials.

[Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) · [Tauri signing](https://v2.tauri.app/distribute/sign/macos/)
