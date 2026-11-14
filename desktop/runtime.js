import fs from 'node:fs';
import path from 'node:path';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { init } from '../src/store.js';
import { activateClaude, restoreClaude } from '../src/claude-config.js';
import { activateClaudeDesktop, restoreClaudeDesktop } from '../src/claude-desktop.js';
import { claudeModelEnvironment } from '../src/claude-models.js';
import { createProxy } from '../src/proxy.js';
import { activateSession, restoreSession, syncSession } from './config.js';

export function protectDirectory(root, { platform = process.platform, run = spawnSync } = {}) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (platform !== 'win32') { fs.chmodSync(root, 0o700); return; }
  const identity = run('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const sid = identity.stdout?.match(/S-1-5-[\d-]+/)?.[0];
  if (!sid) throw new Error('Unable to determine the Windows account SID.');
  // Grant access before removing inheritance. Children inherit the protected root;
  // do not repeatedly remove their own inheritance, including Electron profile files.
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
    const result = run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const outcome = result.stdout?.trim();
    return !result.error && result.status === 0 && ['repaired', 'already-granted', 'different-owner', 'explicit-deny', 'unsupported-file'].includes(outcome) ? outcome : 'failed';
  } catch { return 'failed'; }
}

export class DesktopRuntime {
  constructor({ root, codexHome, claudeHome, claudeDesktop, binary, port = 18345, reauth, claudeReauth, createServer = createProxy, guardExec = process.execPath }) {
    Object.assign(this, { root, codexHome, claudeHome, claudeDesktop, binary, port, reauth, claudeReauth, createServer, guardExec });
    this.recordFile = path.join(root, 'desktop-session.json');
    this.server = null; this.guard = null; this.activeRequests = 0; this.active = false;
    this.pending = Promise.resolve();
    this.routes = { codex: true, claude: true };
    this.requests = { codex: new Set(), claude: new Set() };
  }
  transition(action) {
    const result = this.pending.then(action);
    this.pending = result.catch(() => {});
    return result;
  }
  start() { return this.transition(() => this.startRouting()); }
  stop() { return this.transition(() => this.stopRouting()); }
  clientEnabled(client) { return this.active && this.routes[client] !== false; }
  setClientRouting(client, enabled) {
    return this.transition(async () => {
      if (!['codex', 'claude'].includes(client) || typeof enabled !== 'boolean') throw new Error('Invalid client routing state.');
      if (enabled === this.clientEnabled(client) && (this.active || !enabled)) { this.routes[client] = enabled; return; }
      if (!enabled) {
        if (client === 'codex') { restoreSession(this.recordFile); this.imageTools = false; }
        else { restoreClaude(path.join(this.root, 'claude-session.json')); restoreClaudeDesktop(path.join(this.root, 'claude-desktop-session.json')); }
        this.routes[client] = false;
        for (const response of this.requests[client]) response.destroy();
        if (!Object.values(this.routes).some(Boolean)) await this.stopRouting();
        return;
      }
      this.routes[client] = true;
      try {
        if (!this.server) await this.startRouting();
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
      if (this.claudeHome) activateClaude(this.root, this.claudeHome, this.port, state.token, claudeModelEnvironment(state.providers[state.active]));
      activateClaudeDesktop(this.root, this.claudeDesktop, this.port, state.token);
    } else {
      restoreClaude(path.join(this.root, 'claude-session.json'));
      restoreClaudeDesktop(path.join(this.root, 'claude-desktop-session.json'));
    }
  }
  restore() { restoreSession(this.recordFile); restoreClaude(path.join(this.root, 'claude-session.json')); restoreClaudeDesktop(path.join(this.root, 'claude-desktop-session.json')); }
  async listen() {
    const server = this.createServer({ root: this.root, binary: this.binary, clientEnabled: client => this.clientEnabled(client), reauth: this.reauth, claudeReauth: this.claudeReauth });
    server.on('request', (req, res) => {
      if (req.method !== 'POST') return;
      const client = req.url.startsWith('/claude/') || req.url.startsWith('/claude-desktop/') ? 'claude' : 'codex';
      this.activeRequests++; this.requests[client].add(res);
      res.once('close', () => { this.activeRequests--; this.requests[client].delete(res); });
    });
    const ready = once(server, 'listening');
    server.listen(this.port, '127.0.0.1');
    try { await ready; } catch (error) { server.close(); throw error; }
    this.server = server;
    this.port = server.address().port;
  }
  async startGuard() {
    const child = fork(fileURLToPath(new URL('./guard.cjs', import.meta.url)), [this.recordFile], {
      execPath: this.guardExec, execArgv: [], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
    this.guard = child;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Configuration recovery helper did not start.')), 5000);
      const finish = error => { clearTimeout(timer); child.removeListener('message', message); child.removeListener('error', failed); child.removeListener('exit', failed); error ? reject(error) : resolve(); };
      const message = data => { if (data?.type === 'ready') finish(); };
      const failed = () => finish(new Error('Configuration recovery helper failed.'));
      child.on('message', message); child.once('error', failed); child.once('exit', failed);
    });
  }
  async startRouting() {
    if (this.server) return;
    protectDirectory(this.root);
    this.restore();
    if (!Object.values(this.routes).some(Boolean)) return;
    if (fs.existsSync(path.join(this.root, 'installation.json'))) throw new Error('A CLI service installation already owns the configuration. Uninstall that service before using desktop mode.');
    const { token } = init(this.root);
    try {
      await this.listen();
      await this.startGuard();
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
    if (this.guard?.connected) this.guard.send({ type: 'disarm' });
    this.guard = null;
    if (this.server) {
      const server = this.server; this.server = null;
      const closed = once(server, 'close');
      server.close(); server.closeAllConnections(); await closed;
    }
  }
}
