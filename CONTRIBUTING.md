# Contributing

Thank you for helping improve easy-switch. Focused bug reports, compatibility results, documentation fixes, and pull requests are welcome.

## Development

Use Node.js 22 or later:

```bash
npm ci
npm run check
npm test
```

The default tests use temporary directories and mock upstreams. They must not require real credentials or paid API calls. To test an installed Codex binary against local mock upstreams:

```bash
SWITCH_TEST_CODEX="$(command -v codex)" node --test test/codex.integration.test.js
```

Do not run `./install.sh` just to run tests: it changes the user's Codex configuration and installs a background service on Linux.

## Reporting an issue

Include the expected behavior, actual behavior, minimal reproduction steps, and your OS, Node.js, and Codex versions. For remote extension issues, identify where the extension process runs and which configuration it reads.

Remove API keys, access/refresh tokens, device codes, personal information, and conversation content from logs and screenshots. Do not attach `auth.json`, `state.json`, or unredacted `config.toml` files. Avoid posting exploitable security details publicly; use a private reporting channel if the repository provides one.

## Pull requests

- Keep each change focused and explain the user-visible behavior.
- Add meaningful regression tests for routing, authentication, configuration, or service lifecycle changes.
- Preserve in-flight request routing and credential isolation.
- Update both [English](README.md) and [Simplified Chinese](docs/README.zh-CN.md) READMEs when public behavior changes.
- State what you tested and distinguish mocks from real-provider validation.

Contributions are distributed under the project's [MIT License](docs/LICENSE).

## 参与贡献

欢迎提交问题报告、兼容性验证结果、文档修订和 Pull Request。请保持改动范围集中，为行为变化添加必要测试，并同步更新中英文 README。提交问题时提供环境版本及可复现步骤，不要上传密钥、登录凭据、设备验证码或未脱敏的配置。默认测试无需真实账号或付费 API；运行测试不需要执行安装脚本。贡献内容采用本项目的 MIT 许可证。
