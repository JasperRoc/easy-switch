# Contributing to fluid

Small, focused improvements are welcome: bug fixes, compatibility reports, clear documentation and tests that reproduce real failures.

```bash
npm ci
npm run check
npm test
```

Use Node.js 22.18+. Native development also needs Rust and the host platform’s build tools. See the [development guide](docs/development.md).

- Describe the problem and the resulting behavior. Keep unrelated changes separate.
- Use isolated temporary homes and mock services. Tests must not require personal credentials or paid calls.
- Include validation and platform limits in your pull request. Commit messages should be in English.
- Remove API keys, tokens, personal data and conversation content from reports.

Do not run `./install.sh` merely to test: it registers a Linux service and changes client connection settings.

By contributing, you agree to license your contribution under [MIT](docs/LICENSE).
