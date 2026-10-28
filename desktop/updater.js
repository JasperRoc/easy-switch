import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile, fork, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createUpstreamFetch } from '../src/network.js';
import { atomic } from '../src/store.js';

const repository = 'https://github.com/JasperRoc/easy-switch';
const execute = promisify(execFile);
const api = 'https://api.github.com/repos/JasperRoc/easy-switch/releases?per_page=20';
const versionPattern = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.-]+))?$/;
export function compareVersions(a, b) {
  const left = a.match(versionPattern), right = b.match(versionPattern);
  if (!left || !right) throw new Error('Invalid release version.');
  for (let n = 1; n <= 3; n++) { const diff = Number(left[n]) - Number(right[n]); if (diff) return Math.sign(diff); }
  if (!left[4] || !right[4]) return left[4] ? -1 : right[4] ? 1 : 0;
  return left[4].localeCompare(right[4], 'en', { numeric: true });
}
export function selectRelease(releases, current, platform, arch) {
  if (!Array.isArray(releases)) throw new Error('Invalid GitHub release response.');
  const suffix = platform === 'darwin' ? `mac-${arch}.zip` : platform === 'win32' ? `win-${arch}.exe` : null;
  if (!suffix) throw new Error('Desktop updates support macOS and Windows.');
  const ordered = releases.filter(r => !r.draft && typeof r.tag_name === 'string' && versionPattern.test(r.tag_name) && compareVersions(r.tag_name, current) > 0)
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  for (const release of ordered) {
    const version = release.tag_name.replace(/^v/, '');
    const name = `easy-switch-${version}-${suffix}`;
    const asset = release.assets?.find(item => item.name === name);
    if (!asset) continue;
    const expectedURL = `${repository}/releases/download/${release.tag_name}/${name}`;
    if (asset.browser_download_url !== expectedURL || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '') ||
        !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 2 * 1024 ** 3) throw new Error('The update package has invalid metadata or no SHA-256 digest.');
    return { version, tag: release.tag_name, notes: String(release.body || '').slice(0, 200000), date: release.published_at || '',
      asset: { name, url: expectedURL, sha256: asset.digest.slice(7), size: asset.size } };
  }
  return null;
}
export async function downloadVerified(response, destination, asset, progress = () => {}) {
  if (!response.ok || !response.body) throw new Error('Unable to download the update package.');
  const partial = `${destination}.part`, hash = crypto.createHash('sha256'); let size = 0;
  fs.rmSync(partial, { force: true });
  try {
    const count = new Transform({ transform(chunk, encoding, done) {
      size += chunk.length;
      if (size > asset.size) return done(new Error('Update package exceeds its expected size.'));
      hash.update(chunk); progress(size, asset.size); done(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), count, fs.createWriteStream(partial, { flags: 'wx', mode: 0o600 }));
    if (size !== asset.size || hash.digest('hex') !== asset.sha256) throw new Error('Update package SHA-256 verification failed.');
    fs.renameSync(partial, destination);
  } finally { fs.rmSync(partial, { force: true }); }
}
export function validateArchiveEntries(list) {
  for (const entry of list.split('\n').filter(Boolean)) {
    if (entry.startsWith('/') || entry.replaceAll('\\', '/').split('/').includes('..')) throw new Error('Unsafe update archive path.');
  }
}
export async function verifyMacApplication(application, version) {
  const info = path.join(application, 'Contents', 'Info.plist');
  const read = async key => (await execute('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, info], { encoding: 'utf8' })).stdout.trim();
  if (fs.lstatSync(application).isSymbolicLink() || await read('CFBundleIdentifier') !== 'io.github.jasperroc.easy-switch' || await read('CFBundleShortVersionString') !== version) throw new Error('The staged application identity or version does not match the release.');
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
}
export class DesktopUpdater {
  constructor({ root, current, platform = process.platform, arch = process.arch, changed = () => {}, fetchImpl }) {
    Object.assign(this, { root, current, platform, arch, changed, fetchImpl });
    this.state = { phase: 'idle', current }; this.release = null; this.pending = null; this.staged = null;
    this.directory = path.join(root, 'updates'); fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.receipt = path.join(this.directory, 'pending.json');
    const error = path.join(this.directory, 'last-error.txt');
    if (fs.existsSync(error)) { this.state = { ...this.state, phase: 'error', error: fs.readFileSync(error, 'utf8') }; fs.rmSync(error); }
  }
  snapshot() { return { ...this.state, notes: this.release?.notes || '', date: this.release?.date || '' }; }
  emit(patch) { this.state = { ...this.state, ...patch }; this.changed(); }
  async connection(operation) {
    const client = this.fetchImpl ? null : createUpstreamFetch(this.root);
    try { return await operation(this.fetchImpl || client.fetch); } finally { await client?.close(); }
  }
  async check() {
    if (this.pending || ['ready', 'installing'].includes(this.state.phase)) return this.snapshot();
    this.emit({ phase: 'checking', error: '' });
    this.pending = this.connection(async fetch => {
      const response = await fetch(api, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'easy-switch-desktop' }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Unable to check GitHub updates.'); }
      this.release = selectRelease(await response.json(), this.current, this.platform, this.arch);
      this.emit({ phase: this.release ? 'available' : 'current', version: this.release?.version || '', checkedAt: Date.now() });
    }).catch(error => this.emit({ phase: 'error', error: error.message })).finally(() => { this.pending = null; });
    await this.pending; return this.snapshot();
  }
  async download() {
    if (this.pending) return this.pending;
    if (!this.release) throw new Error('Check for an update first.');
    const release = this.release, target = path.join(this.directory, release.asset.name);
    this.emit({ phase: 'downloading', received: 0, total: release.asset.size, error: '' });
    this.pending = this.connection(async fetch => {
      const response = await fetch(release.asset.url, { headers: { 'user-agent': 'easy-switch-desktop' }, signal: AbortSignal.timeout(20 * 60 * 1000) });
      let last = 0;
      await downloadVerified(response, target, release.asset, (received, total) => { if (Date.now() - last > 150) { last = Date.now(); this.emit({ received, total }); } });
      if (this.platform === 'darwin') {
        const entries = await execute('/usr/bin/unzip', ['-Z', '-1', target], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
        validateArchiveEntries(entries.stdout);
        const directory = fs.mkdtempSync(path.join(this.directory, 'stage-'));
        try {
          await execute('/usr/bin/ditto', ['-x', '-k', target, directory]);
          const application = path.join(directory, 'easy-switch.app'); await verifyMacApplication(application, release.version);
          this.staged = application;
        } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
      } else this.staged = target;
      this.emit({ phase: 'ready', received: release.asset.size });
    }).catch(error => { this.emit({ phase: 'error', error: error.message }); throw error; }).finally(() => { this.pending = null; });
    return this.pending;
  }
  confirmLaunch() {
    if (!fs.existsSync(this.receipt)) return;
    const pending = JSON.parse(fs.readFileSync(this.receipt, 'utf8'));
    if (pending.version === this.current) atomic(this.receipt, { ...pending, ready: true });
  }
  async install({ executable = process.execPath, codexHome }) {
    if (this.state.phase !== 'ready' || !this.staged) throw new Error('Download and verify the update first.');
    const version = this.release.version;
    if (this.platform === 'darwin') {
      const current = path.resolve(path.dirname(executable), '..', '..');
      if (!current.endsWith('.app') || current.includes('/AppTranslocation/') || fs.lstatSync(current).isSymbolicLink()) throw new Error('Move easy-switch to Applications and launch it there before updating.');
      fs.accessSync(path.dirname(current), fs.constants.W_OK);
      const token = crypto.randomUUID(); atomic(this.receipt, { version, token, ready: false });
      const descriptor = path.join(this.directory, 'install.json');
      atomic(descriptor, { parent: process.pid, current, staged: this.staged, receipt: this.receipt, version, token,
        archive: path.join(this.directory, this.release.asset.name), environment: { SWITCH_HOME: this.root, CODEX_HOME: codexHome } });
      const helper = path.join(this.directory, 'install.cjs'); fs.copyFileSync(fileURLToPath(new URL('./update-helper.cjs', import.meta.url)), helper);
      const child = fork(helper, [descriptor], { execPath: executable, execArgv: [], detached: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Update helper did not start.')); }, 6000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('message', message => { clearTimeout(timer); message?.ready ? resolve() : reject(new Error('Update helper failed.')); });
      });
      child.send({ install: true }); child.disconnect(); child.unref();
    } else {
      const literal = value => `'${value.replaceAll("'", "''")}'`;
      const command = `$ErrorActionPreference='Stop'; while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 200 }; Start-Process -FilePath ${literal(this.staged)} -ArgumentList '/S','--updated','--force-run' -Wait`;
      const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { detached: true, windowsHide: true, stdio: 'ignore' });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
    }
    this.emit({ phase: 'installing' });
  }
}
