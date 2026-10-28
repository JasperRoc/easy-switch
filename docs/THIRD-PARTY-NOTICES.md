# Third-party components

Desktop distributions include Electron (MIT), Node.js and Chromium (their bundled notices), and the official OpenAI Codex CLI **0.165.0** (Apache-2.0). Codex is used for official device sign-in and local model-catalog discovery. Its source is available at <https://github.com/openai/codex/tree/rust-v0.165.0>; its license is included as [CODEX-LICENSE](CODEX-LICENSE) and alongside the bundled executable.

The bundled Codex executable comes from the matching, pinned `@openai/codex` npm platform package. macOS distribution signing may update its signature without changing its program code. Audio and code-execution helpers are not bundled because the desktop application does not use those features. Desktop users still use their own Codex client for conversations.

Runtime dependencies include `smol-toml` (MIT) and `undici` (MIT). Their license files and Electron's component notices are included with the packaged dependencies. Build-time dependencies are listed in `package.json` and `package-lock.json`.

OpenAI, ChatGPT, Codex, Windows and macOS are trademarks of their respective owners. This independent project does not imply sponsorship or endorsement.
