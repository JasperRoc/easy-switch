import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { init, type Client } from '../src/store.js';
import { activateClaude, claudeCompactWindows, restoreClaude } from '../src/claude-config.js';
import { activateClaudeDesktop, restoreClaudeDesktop } from '../src/claude-desktop.js';
import { claudeModelEnvironment } from '../src/claude-models.js';
import { activateSession, restoreSession, syncSession } from './config.js';

export function protectDirectory(root, { platform = process.platform, run = spawnSync } = {}) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (platform !== 'win32') { fs.chmodSync(root, 0o700); return; }
  const identity = run('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const sid = identity.stdout?.match(/S-1-5-[\d-]+/)?.[0];
  if (!sid) throw new Error('Unable to determine the Windows account SID.');
  // Grant access before removing inheritance. Children inherit the protected root;
  // Existing files keep their own access entries during recovery.
  for (const args of [[root, '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '/Q'], [root, '/inheritance:r', '/Q']]) {
    const acl = run('icacls', args, { encoding: 'utf8', windowsHide: true });
    if (acl.error || acl.status !== 0) throw new Error('Unable to protect the credentials directory with Windows ACLs.');
  }
}
export function repairPreferencesAccess(file, { platform = process.platform, run = spawnSync } = {}) {
  if (platform !== 'win32') return 'not-windows';
  try {
    const script = fs.readFileSync(new URL('./preferences-access.ps1', import.meta.url), 'utf8');
    const command = `& {${script}} -PreferenceFile ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(file).toString('base64')}')))`;
    const result = run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const outcome = result.stdout?.trim();
    return !result.error && result.status === 0 && ['repaired', 'already-granted', 'different-owner', 'explicit-deny', 'unsupported-file'].includes(outcome) ? outcome : 'failed';
  } catch { return 'failed'; }
}

interface RuntimeOptions {
  root: string;
  codexHome: string;
  claudeHome?: string;
  claudeDesktop?: { normal: string; thirdParty: string };
  port?: number;
}

export class DesktopRuntime {
  declare root: string;
  declare codexHome: string;
  declare claudeHome?: string;
  declare claudeDesktop?: RuntimeOptions['claudeDesktop'];
  declare port: number;
  declare recordFile: string;
  declare active: boolean;
  declare pending: Promise<void>;
  declare routes: Record<Client, boolean>;
  declare imageTools?: boolean;

  constructor({ root, codexHome, claudeHome, claudeDesktop, port = 18345 }: RuntimeOptions) {
    Object.assign(this, { root, codexHome, claudeHome, claudeDesktop, port });
    this.recordFile = path.join(root, 'desktop-session.json');
    this.active = false;
    this.pending = Promise.resolve();
    this.routes = { codex: true, claude: true };
  }
  transition(action: () => Promise<void>) {
    const result = this.pending.then(action);
    this.pending = result.catch(() => {});
    return result;
  }
  start() { return this.transition(() => this.startRouting()); }
  stop() { return this.transition(() => this.stopRouting()); }
  clientEnabled(client: Client) { return this.active && this.routes[client] !== false; }
  setClientRouting(client: Client, enabled: boolean) {
    return this.transition(async () => {
      if (!['codex', 'claude'].includes(client) || typeof enabled !== 'boolean') throw new Error('Invalid client routing state.');
      if (enabled === this.clientEnabled(client) && (this.active || !enabled)) { this.routes[client] = enabled; return; }
      if (!enabled) {
        if (client === 'codex') { restoreSession(this.recordFile); this.imageTools = false; }
        else { restoreClaude(path.join(this.root, 'claude-session.json')); restoreClaudeDesktop(path.join(this.root, 'claude-desktop-session.json')); }
        this.routes[client] = false;
        if (!Object.values(this.routes).some(Boolean)) await this.stopRouting();
        return;
      }
      this.routes[client] = true;
      try {
        if (!this.active) await this.startRouting();
        else if (client === 'codex') { activateSession(this.root, this.codexHome, this.port, init(this.root).token); this.syncTools(); }
        else this.syncClaude();
      } catch (error) { this.routes[client] = false; throw error; }
    });
  }
  syncTools() { if (this.clientEnabled('codex')) this.imageTools = syncSession(this.root, this.codexHome); }
  syncClaude() {
    if (!this.clientEnabled('claude')) return;
    const state = init(path.join(this.root, 'claude'));
    if (Object.keys(state.providers).length) {
      if (this.claudeHome) activateClaude(this.root, this.claudeHome, this.port, state.token, claudeModelEnvironment(state.providers[state.active]), claudeCompactWindows(state.providers[state.active]));
      activateClaudeDesktop(this.root, this.claudeDesktop, this.port, state.token);
    } else {
      restoreClaude(path.join(this.root, 'claude-session.json'));
      restoreClaudeDesktop(path.join(this.root, 'claude-desktop-session.json'));
    }
  }
  restore() { restoreSession(this.recordFile); restoreClaude(path.join(this.root, 'claude-session.json')); restoreClaudeDesktop(path.join(this.root, 'claude-desktop-session.json')); }
  attach() {
    this.active = ['desktop-session.json', 'claude-session.json', 'claude-desktop-session.json'].some(file => fs.existsSync(path.join(this.root, file)));
    this.imageTools = this.active && fs.existsSync(this.recordFile) && !!JSON.parse(fs.readFileSync(this.recordFile, 'utf8')).nativeTools;
  }
  async startRouting() {
    if (this.active) return;
    this.restore();
    if (!Object.values(this.routes).some(Boolean)) return;
    if (fs.existsSync(path.join(this.root, 'installation.json'))) throw new Error('A CLI service installation already owns the configuration. Uninstall that service before using desktop mode.');
    const { token } = init(this.root);
    try {
      if (this.routes.codex) activateSession(this.root, this.codexHome, this.port, token);
      this.active = true;
      this.syncTools();
      this.syncClaude();
    } catch (error) {
      await this.stopRouting(); throw error;
    }
  }
  async stopRouting() {
    // Restore while the proxy is still available. A conflict leaves it running.
    this.restore();
    this.active = false;
    this.imageTools = false;
  }
}
