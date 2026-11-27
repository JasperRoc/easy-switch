import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export type CodexExecutable = string | (() => string);

export function resolveCodexExecutable(binary: CodexExecutable) {
  return typeof binary === 'function' ? binary() : binary;
}

export function codexVersionNumber(value?: string | null): string | undefined {
  return /^([0-9]{1,4}(?:\.[0-9]{1,4}){2})(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.exec(value || '')?.[1];
}

export function codexRequestVersion(userAgent?: string, originator?: string): string | undefined {
  if (originator && userAgent?.startsWith(originator + '/'))
    return codexVersionNumber(userAgent.slice(originator.length + 1).split(/\s/, 1)[0]);
  return codexVersionNumber(/^(?:codex(?:[-_][\w.-]+)?|codex desktop)\/([^\s]+)/i.exec(userAgent || '')?.[1]);
}

async function codexExecutableVersion(binary: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const { stdout } = await execute(binary, ['--version'], { timeout: 5000, windowsHide: true, maxBuffer: 8192, signal });
    return codexVersionNumber(/^codex(?:-cli)?\s+(\S+)/i.exec(stdout.trim())?.[1]);
  } catch (error) {
    if (signal?.aborted) throw error;
  }
}

export async function installedCodexVersion(signal?: AbortSignal) {
  let installed: string | undefined;
  try { installed = codexBinary(); }
  catch {
    // A systemd unit can still point at a VS Code extension that was upgraded.
    if (process.env.SWITCH_CODEX_BIN) {
      try { installed = codexBinary({ env: { ...process.env, SWITCH_CODEX_BIN: undefined } }); } catch {}
    }
  }
  return installed ? codexExecutableVersion(installed, signal) : undefined;
}

function* codexExecutables({ env = process.env, userHome = os.homedir(), arch = process.arch, platform = process.platform } = {}) {
  const paths = platform === 'win32' && process.platform === 'win32' ? path.win32 : path;
  const join = (...parts: string[]) => paths.join(...parts);
  const entries = directory => { try { return fs.readdirSync(directory, { withFileTypes: true }); } catch { return []; } };
  const usable = file => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } };
  if (env.SWITCH_CODEX_BIN) {
    const file = paths.isAbsolute(env.SWITCH_CODEX_BIN) ? env.SWITCH_CODEX_BIN : (env.PATH || '').split(platform === 'win32' ? ';' : ':').map(dir => join(dir, env.SWITCH_CODEX_BIN)).find(usable);
    if (file && usable(file)) yield file;
  }
  const name = platform === 'win32' ? 'codex.exe' : 'codex';
  const nodeVersions = [join(userHome, '.nvm', 'versions', 'node'), join(userHome, '.local', 'share', 'mise', 'installs', 'node'), join(userHome, '.asdf', 'installs', 'nodejs')]
    .flatMap(directory => entries(directory).filter(item => item.isDirectory()).sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true })).slice(0, 8).map(item => join(directory, item.name, 'bin')));
  const search = [join(userHome, '.local', 'bin'), ...(env.PATH || '').split(platform === 'win32' ? ';' : ':').filter(Boolean), ...nodeVersions,
    ...(platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : []),
    ...(platform === 'win32' ? [env.NVM_SYMLINK, join(env.APPDATA || join(userHome, 'AppData', 'Roaming'), 'npm')].filter(Boolean) : [])];
  for (const file of search.map(dir => join(dir, name))) if (usable(file)) yield file;
  // npm's Windows command is a .cmd shim, which cannot be spawned directly by
  // app-server. Resolve its native package instead of invoking a shell.
  const target = `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-${platform === 'win32' ? 'pc-windows-msvc' : platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}`;
  const npm = search.flatMap(dir => [join(dir, 'node_modules', '@openai'), join(dir, '..', 'lib', 'node_modules', '@openai')]);
  for (const directory of npm) for (const pkg of entries(directory)) {
    if (!pkg.isDirectory() || !/^codex(?:-|$)/.test(pkg.name)) continue;
    for (const base of [join(directory, pkg.name), ...entries(join(directory, pkg.name, 'node_modules', '@openai')).map(item => join(directory, pkg.name, 'node_modules', '@openai', item.name))]) {
      const file = join(base, 'vendor', target, 'codex', name); if (usable(file)) yield file;
    }
  }
  if (platform === 'darwin') {
    const installed = ['/Applications', path.join(userHome, 'Applications')].flatMap(directory =>
      ['ChatGPT.app', 'Codex.app'].flatMap(app => [path.join(directory, app, 'Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex'),
        path.join(directory, app, 'Contents', 'Resources', 'codex-cli', 'bin', 'codex'), path.join(directory, app, 'Contents', 'Resources', 'codex')]));
    for (const file of installed) if (usable(file)) yield file;
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(userHome, 'AppData', 'Local');
    const installed = [path.join(local, 'Microsoft', 'WindowsApps', name),
      ...['Codex', 'ChatGPT'].flatMap(app => [path.join(local, 'Programs', app, 'resources', name), path.join(local, 'Programs', app, 'resources', 'codex-cli', 'bin', name)])];
    for (const file of installed) if (usable(file)) yield file;
  }
  const extensions = [];
  const editors = platform === 'linux' ? ['.vscode-server', '.vscode-server-insiders', '.cursor-server', '.vscode', '.vscode-insiders', '.cursor']
    : ['.vscode', '.vscode-insiders', '.cursor'];
  const binPlatform = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux';
  const extensionDirs = [...new Set([...editors.map(editor => path.join(userHome, editor, 'extensions')), env.VSCODE_EXTENSIONS, env.VSCODE_AGENT_FOLDER && path.join(env.VSCODE_AGENT_FOLDER, 'extensions')].filter(Boolean))];
  for (const directory of extensionDirs) {
    let entries; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if ((!entry.isDirectory() && !entry.isSymbolicLink()) || !/^openai\.(?:chatgpt|codex)-\d/.test(entry.name)) continue;
      for (const suffix of arch === 'arm64' && platform === 'win32' ? ['-aarch64', '-x86_64'] : [arch === 'arm64' ? '-aarch64' : '-x86_64']) {
        const file = path.join(directory, entry.name, 'bin', binPlatform + suffix, name);
        if (usable(file)) extensions.push(file);
      }
    }
  }
  extensions.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  yield* extensions;
  if (platform === 'win32' && process.platform === 'win32') {
    try {
      // Store installations do not always register a usable execution alias.
      const powershell = join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const installed = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        "Get-AppxPackage | Where-Object { $_.Name -match '(?i)(OpenAI|ChatGPT|Codex)' } | Select-Object -ExpandProperty InstallLocation"],
        { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 32768 }).trim().split(/\r?\n/).filter(base => path.win32.isAbsolute(base));
      for (const base of installed) for (const file of [join(base, 'app', 'resources', name), join(base, 'app', 'resources', 'codex-cli', 'bin', name), join(base, 'resources', name), join(base, 'resources', 'codex-cli', 'bin', name), join(base, 'codex-cli', 'bin', name)])
        if (usable(file)) yield file;
    } catch {}
  }
}

export function codexBinary(options: Parameters<typeof codexExecutables>[0] = {}) {
  const binary = codexExecutables(options).next().value;
  if (binary) return binary;
  throw new Error('Codex executable was not found. Install the Codex CLI or editor extension, or set SWITCH_CODEX_BIN.');
}

const executableVersions = new Map<string, Promise<string | undefined>>();
export async function codexExecutableForVersion(source: CodexExecutable, requested?: string, options: Parameters<typeof codexExecutables>[0] = {}) {
  const version = codexVersionNumber(requested);
  if (!version) return resolveCodexExecutable(source);
  const seen = new Set<string>();
  const matches = async (binary: string) => {
    if (seen.has(binary)) return false;
    seen.add(binary);
    try {
      const stat = fs.statSync(binary), key = `${binary}:${stat.size}:${stat.mtimeMs}`;
      if (!executableVersions.has(key)) {
        if (executableVersions.size >= 64) executableVersions.delete(executableVersions.keys().next().value);
        executableVersions.set(key, codexExecutableVersion(binary));
      }
      const found = await executableVersions.get(key);
      if (!found) executableVersions.delete(key);
      return found === version;
    } catch { return false; }
  };
  try { const preferred = resolveCodexExecutable(source); if (await matches(preferred)) return preferred; } catch {}
  let batch: string[] = [];
  for (const binary of codexExecutables(options)) {
    if (seen.has(binary) || batch.includes(binary)) continue;
    batch.push(binary);
    if (batch.length < 4) continue;
    const found = await Promise.all(batch.map(matches));
    const index = found.indexOf(true);
    if (index >= 0) return batch[index];
    batch = [];
  }
  const found = await Promise.all(batch.map(matches));
  const index = found.indexOf(true);
  return index < 0 ? undefined : batch[index];
}
