import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { restoreSession } from './config.js';
import { restoreClaude } from '../src/claude-config.js';
import { restoreClaudeDesktop } from '../src/claude-desktop.js';
import { removeClaudeLogin } from '../src/claude-auth.js';

// Restore client settings before deleting the only recovery records.
export async function removeDesktopData(root, { removeLogin = removeClaudeLogin, home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  root = path.resolve(root);
  if (root === path.parse(root).root || root === path.resolve(home) || fs.lstatSync(root).isSymbolicLink())
    throw new Error('Refusing to remove an unsafe application data directory.');
  for (const name of ['desktop-session.json', 'claude-session.json', 'claude-desktop-session.json']) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const target of [record.file, record.auth?.file, ...(record.files || []).map(entry => entry.file)].filter(Boolean)) {
      if (path.resolve(target).startsWith(root + path.sep)) throw new Error('Client data is inside the application data directory. Move it before uninstalling.');
    }
  }
  restoreSession(path.join(root, 'desktop-session.json'));
  restoreClaude(path.join(root, 'claude-session.json'));
  restoreClaudeDesktop(path.join(root, 'claude-desktop-session.json'));
  const accounts = path.join(root, 'claude', 'accounts');
  if (fs.existsSync(accounts)) for (const entry of fs.readdirSync(accounts, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) await removeLogin(path.join(accounts, entry.name));
  }
  fs.rmSync(root, { recursive: true, force: true });
  const leftovers = platform === 'darwin' ? [
    path.join(home, 'Library', 'Application Support', 'fluid'), path.join(home, 'Library', 'Caches', 'fluid'),
    path.join(home, 'Library', 'Logs', 'fluid'), path.join(home, 'Library', 'Preferences', 'io.github.jasperroc.fluid.plist'),
    path.join(home, 'Library', 'Saved Application State', 'io.github.jasperroc.fluid.savedState'),
  ] : platform === 'win32' ? [path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'fluid')] : [];
  if (root === path.join(home, '.fluid')) for (const file of leftovers) fs.rmSync(file, { recursive: true, force: true });
}
