import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { atomic } from './store.js';

const execute = promisify(execFile);
export function claudeHeaders(provider, token, incoming = {}) {
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  for (const [key, value] of Object.entries(incoming)) if (/^(anthropic-|x-stainless-|x-claude-code-)/.test(key) || ['user-agent', 'x-app', 'accept'].includes(key)) headers[key] = value;
  if (provider.type === 'account') {
    headers.authorization = `Bearer ${token}`;
    headers['anthropic-beta'] = [...new Set((headers['anthropic-beta'] || '').split(',').filter(Boolean).concat('oauth-2025-04-20'))].join(',');
  } else { headers['x-api-key'] = provider.apiKey; headers.authorization = `Bearer ${provider.apiKey}`; }
  return headers;
}
export const claudeEndpoint = provider => (provider.baseUrl || 'https://api.anthropic.com').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
const keychainService = directory => 'Claude Code-credentials-' + createHash('sha256').update(directory).digest('hex').slice(0, 8);
export async function removeClaudeLogin(directory, executeImpl = execute) {
  if (process.platform !== 'darwin') return;
  try { await executeImpl('/usr/bin/security', ['delete-generic-password', '-s', keychainService(directory), '-a', process.env.USER || os.userInfo().username], { timeout: 10000 }); }
  catch (error) { if (error.code !== 44) throw new Error('Unable to remove this isolated Claude Keychain login. Allow Keychain access and retry.'); }
}
export const claudeHome = () => path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
export function claudeBinary() {
  if (process.env.SWITCH_CLAUDE_BIN) return process.env.SWITCH_CLAUDE_BIN;
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const dirs = [path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', ...(process.env.PATH || '').split(path.delimiter)];
  if (process.platform === 'win32' && process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin'));
  const binary = dirs.map(dir => path.join(dir, name)).find(file => fs.existsSync(file));
  if (!binary) throw new Error('Install Claude Code first, or set SWITCH_CLAUDE_BIN to its executable.');
  return binary;
}
export async function existingClaudeAuth(directory = claudeHome(), { platform = process.platform, explicit = !!process.env.CLAUDE_CONFIG_DIR, executeImpl = execute } = {}) {
  let credentials;
  if (platform === 'darwin') {
    const suffix = explicit ? '-' + createHash('sha256').update(directory).digest('hex').slice(0, 8) : '';
    try {
      const { stdout } = await executeImpl('/usr/bin/security', ['find-generic-password', '-s', `Claude Code-credentials${suffix}`, '-a', process.env.USER || os.userInfo().username, '-w'], { timeout: 10000, maxBuffer: 1024 * 1024 });
      credentials = JSON.parse(stdout);
    } catch { /* Claude Code also supports file storage when Keychain is unavailable. */ }
  }
  if (!credentials) {
    try { credentials = JSON.parse(fs.readFileSync(path.join(directory, '.credentials.json'), 'utf8')); } catch {}
  }
  const oauth = credentials?.claudeAiOauth;
  if (!oauth?.accessToken || !oauth.scopes?.includes('user:inference')) throw new Error('No Claude subscription sign-in was found. Add a subscription first.');
  return oauth;
}
export function claudeAuth(provider) {
  const auth = JSON.parse(fs.readFileSync(path.join(provider.accountHome, 'oauth.json'), 'utf8'));
  if (!auth.accessToken) throw new Error('Claude subscription authentication required.');
  return auth;
}
export const claudeExpired = auth => typeof auth.expiresAt === 'number' && auth.expiresAt <= Date.now() + 60000;
const refreshing = new Map();
export async function claudeToken(provider, fetchImpl) {
  const auth = claudeAuth(provider);
  if (!claudeExpired(auth)) return auth.accessToken;
  if (!auth.refreshToken) throw new Error('Claude subscription authentication required.');
  const file = path.join(provider.accountHome, 'oauth.json');
  if (refreshing.has(file)) return refreshing.get(file);
  const operation = (async () => {
    const response = await fetchImpl('https://platform.claude.com/v1/oauth/token', { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: auth.refreshToken, client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e' }) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Claude subscription authentication required.'); }
    const next = await response.json();
    if (typeof next.access_token !== 'string' || !Number.isFinite(next.expires_in)) throw new Error('Claude subscription authentication required.');
    // Never recreate removed credentials or overwrite a separate sign-in.
    const current = claudeAuth(provider);
    if (current.accessToken !== auth.accessToken) return current.accessToken;
    atomic(file, { ...auth, accessToken: next.access_token, refreshToken: next.refresh_token || auth.refreshToken,
      expiresAt: Date.now() + next.expires_in * 1000 });
    return next.access_token;
  })();
  refreshing.set(file, operation);
  try { return await operation; } finally { refreshing.delete(file); }
}

// Delegate browser authentication and PKCE handling to the official client.
export function startClaudeLogin({ directory, binary = claudeBinary(), env = process.env, spawnImpl = spawn, readAuth = existingClaudeAuth }) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const isolated = { ...env, CLAUDE_CONFIG_DIR: directory, BROWSER: process.platform === 'win32' ? undefined : '/usr/bin/true' };
  isolated.PATH = [...new Set([path.dirname(binary), ...(env.PATH || '').split(path.delimiter), ...(process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [])])].join(path.delimiter);
  for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS']) delete isolated[key];
  const login = { phase: 'starting', message: 'Opening official Claude subscription sign-in…' };
  let ready, complete, buffer = '', settled = false, cancelled = false;
  login.ready = new Promise(resolve => { ready = resolve; });
  login.completed = new Promise(resolve => { complete = resolve; });
  const child = spawnImpl(binary, ['auth', 'login', '--claudeai'], { env: isolated, cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const finish = async success => {
    if (settled) return; settled = true; clearTimeout(timer);
    try {
      if (!success) throw Error();
      const auth = await readAuth(directory, { explicit: true });
      if (cancelled) throw Error();
      atomic(path.join(directory, 'oauth.json'), auth);
      login.phase = 'complete'; login.message = 'Signed in successfully.';
    } catch { login.phase = 'failed'; login.message = 'Claude sign-in failed. Retry with the latest Claude Code installed.'; }
    delete login.url; delete login.codeRequired; ready(); complete(login.phase === 'complete');
  };
  const timer = setTimeout(() => { child.kill(); finish(false); }, 10 * 60 * 1000);
  const output = chunk => {
    buffer = (buffer + chunk.toString()).slice(-32768);
    const url = buffer.match(/https:\/\/(?:claude\.com|claude\.ai)\/(?:cai\/)?oauth\/authorize\?[^\s\u001b\u0007]+/)?.[0];
    if (url && !login.url && !settled) { login.url = url; login.phase = 'pending'; login.codeRequired = true; login.message = 'Complete sign-in in your browser, then paste the authorization code here.'; ready(); }
  };
  child.stdout.on('data', output); child.stderr.on('data', output);
  child.stdin.on('error', () => {});
  child.once('error', () => finish(false)); child.once('close', code => finish(code === 0));
  login.submit = code => {
    if (settled || !login.codeRequired || typeof code !== 'string' || !code.trim() || code.length > 4096 || /[\r\n]/.test(code)) throw new Error('Enter the authorization code from the official Claude sign-in page.');
    child.stdin.write(code.trim() + '\n'); login.codeRequired = false;
  };
  login.cancel = () => { cancelled = true; child.kill(); finish(false); };
  return login;
}
