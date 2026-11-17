import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function codexBinary({ env = process.env, userHome = os.homedir(), arch = process.arch } = {}) {
  const usable = file => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } };
  if (env.SWITCH_CODEX_BIN) {
    const file = path.isAbsolute(env.SWITCH_CODEX_BIN) ? env.SWITCH_CODEX_BIN : (env.PATH || '').split(path.delimiter).map(dir => path.join(dir, env.SWITCH_CODEX_BIN)).find(usable);
    if (file && usable(file)) return file;
    throw new Error('SWITCH_CODEX_BIN does not point to an executable Codex program.');
  }
  const shell = [path.join(userHome, '.local', 'bin'), ...(env.PATH || '').split(path.delimiter)].map(dir => path.join(dir, 'codex')).find(usable);
  if (shell) return shell;
  const extensions = [];
  for (const editor of ['.vscode-server', '.vscode-server-insiders', '.cursor-server']) {
    const directory = path.join(userHome, editor, 'extensions');
    let entries; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^openai\.(?:chatgpt|codex)-\d/.test(entry.name)) continue;
      const file = path.join(directory, entry.name, 'bin', arch === 'arm64' ? 'linux-aarch64' : 'linux-x86_64', 'codex');
      if (usable(file)) extensions.push(file);
    }
  }
  extensions.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  if (extensions.length) return extensions[0];
  throw new Error('Codex CLI or its VS Code Remote extension was not found. Install either, or set SWITCH_CODEX_BIN.');
}
