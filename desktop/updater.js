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
function updateError(error, action) {
  if (error instanceof TypeError || ['AbortError', 'TimeoutError'].includes(error.name) ||
      error.cause?.code || /net::ERR_|fetch failed|terminated/i.test(error.message)) {
    return action === 'check' ? 'Unable to reach GitHub. Check your connection or system proxy and retry.'
      : 'Unable to download from GitHub release assets. Check your connection or system proxy and retry the download.';
  }
  return error.message;
}
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
export async function downloadPackage(fetch, asset, destination, progress = () => {}) {
  // Large official assets can use concurrent byte ranges. Each part is bounded,
  // and the assembled file must still match GitHub's full-file SHA-256 digest.
  if (asset.size < 16 * 1024 * 1024) {
    return downloadVerified(await fetch(asset.url, { signal: AbortSignal.timeout(20 * 60000) }), destination, asset, progress);
  }
  const partial = `${destination}.part`, receipt = `${destination}.parts.json`, count = 4;
  let saved = { sha256: asset.sha256, size: asset.size, completed: [] };
  try {
    const previous = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    if (previous.sha256 === asset.sha256 && previous.size === asset.size && previous.count === count &&
        fs.statSync(partial).size === asset.size && Array.isArray(previous.completed)) saved = previous;
  } catch {}
  saved.count = count;
  const range = index => ({ start: Math.floor(asset.size * index / count), end: Math.floor(asset.size * (index + 1) / count) - 1 });
  const completed = new Set(saved.completed.filter(index => Number.isInteger(index) && index >= 0 && index < count));
  const bytes = Array.from({ length: count }, (_, index) => completed.has(index) ? range(index).end - range(index).start + 1 : 0);
  const abort = new AbortController(); let fallback;
  const fd = fs.openSync(partial, completed.size ? 'r+' : 'w+', 0o600);
  fs.ftruncateSync(fd, asset.size);
  const report = () => progress(bytes.reduce((sum, size) => sum + size, 0), asset.size);
  try {
    const first = [...Array(count).keys()].find(index => !completed.has(index));
    if (first !== undefined) {
      const { start, end } = range(first);
      const response = await fetch(asset.url, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20 * 60000)]) });
      if (response.status === 200) fallback = response;
      else {
        const writePart = async (index, response) => {
          const { start, end } = range(index);
          if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${asset.size}` || !response.body) {
            await response.body?.cancel(); throw new Error('The update server returned an invalid byte range.');
          }
          let received = 0;
          for await (const chunk of response.body) {
            if (received + chunk.length > end - start + 1) throw new Error('Update range exceeds its expected size.');
            let written = 0;
            while (written < chunk.length) written += fs.writeSync(fd, chunk, written, chunk.length - written, start + received + written);
            received += chunk.length; bytes[index] = received; report();
          }
          if (received !== end - start + 1) throw new Error('The update range ended early. Retry to resume the download.');
          completed.add(index); saved.completed = [...completed]; atomic(receipt, saved);
        };
        const tasks = [writePart(first, response), ...[...Array(count).keys()].filter(index => index !== first && !completed.has(index)).map(async index => {
          const { start, end } = range(index);
          await writePart(index, await fetch(asset.url, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20 * 60000)]) }));
        })];
        const results = await Promise.allSettled(tasks.map(task => task.catch(error => { abort.abort(); throw error; })));
        const failure = results.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
      }
    }
  } finally { fs.closeSync(fd); }
  if (fallback) {
    fs.rmSync(receipt, { force: true });
    return downloadVerified(fallback, destination, asset, progress);
  }
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(partial)) hash.update(chunk);
  if (hash.digest('hex') !== asset.sha256) {
    fs.rmSync(partial, { force: true }); fs.rmSync(receipt, { force: true });
    throw new Error('Update package SHA-256 verification failed.');
  }
  fs.renameSync(partial, destination); fs.rmSync(receipt, { force: true }); report();
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
export async function startWindowsUpdate(job, bundledHelper, run = spawn) {
  const directory = path.dirname(job.receipt);
  const helper = path.join(directory, 'windows-update.exe');
  const handshake = path.join(directory, 'helper-ready.txt');
  const failure = path.join(directory, 'last-error.txt');
  try { fs.copyFileSync(bundledHelper, helper); }
  catch (error) { throw new Error(`Unable to prepare the Windows update helper (${error.code}).`, { cause: error }); }
  for (const file of [handshake, failure, path.join(directory, 'app-ready.txt')]) fs.rmSync(file, { force: true });
  const fields = { parent: job.parent, current: job.current, installer: job.staged, version: job.version.split('-')[0], token: job.token };
  const ini = '\ufeff[update]\r\n' + Object.entries(fields).map(([key, value]) => `${key}=${value}\r\n`).join('');
  fs.writeFileSync(path.join(directory, 'windows-install.ini'), ini, { encoding: 'utf16le', mode: 0o600 });
  const env = { ...process.env, ...job.environment };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = run(helper, [], { cwd: directory, env, detached: true, windowsHide: true, stdio: 'ignore' });
  const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
  try {
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearInterval(poll); clearTimeout(timer);
        child.removeListener('error', failed); child.removeListener('exit', exited);
        error ? reject(error) : resolve();
      };
      const failed = error => finish(new Error(`Unable to start the Windows update helper (${error.code || error.message}).`));
      const exited = (code, signal) => finish(new Error(read(failure) || `The Windows update helper exited before it was ready (${code ?? signal}).`));
      const poll = setInterval(() => {
        if (read(handshake) === job.token && child.exitCode == null && child.signalCode == null) finish();
      }, 100);
      const timer = setTimeout(() => {
        finish(new Error(read(failure) || 'The Windows update helper did not become ready within 60 seconds.'));
      }, 60000);
      child.once('error', failed); child.once('exit', exited);
    });
    child.unref();
  } catch (error) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.once('error', () => {});
      child.kill();
    }
    throw error;
  }
}
export class DesktopUpdater {
  constructor({ root, current, platform = process.platform, arch = process.arch, changed = () => {}, fetchImpl, systemFetch, useSystemNetwork = () => true }) {
    Object.assign(this, { root, current, platform, arch, changed, fetchImpl, systemFetch, useSystemNetwork });
    this.state = { phase: 'idle', current }; this.release = null; this.pending = null; this.staged = null;
    this.directory = path.join(root, 'updates'); fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.receipt = path.join(this.directory, 'pending.json');
    const error = path.join(this.directory, 'last-error.txt');
    if (fs.existsSync(error)) { this.state = { ...this.state, phase: 'error', failedAction: 'install', error: fs.readFileSync(error, 'utf8') }; this.installErrorPending = true; fs.rmSync(error); }
  }
  get canRevealInstaller() { return this.platform === 'win32' && this.state.phase === 'ready' && !!this.staged; }
  snapshot() { return { ...this.state, canRevealInstaller: this.canRevealInstaller, retryDownload: this.state.phase === 'error' && this.state.failedAction === 'download' && !!this.release,
    notes: this.release?.notes || '', date: this.release?.date || '', size: this.release?.asset.size || 0 }; }
  emit(patch) { this.state = { ...this.state, ...patch }; this.changed(); }
  async connection(operation) {
    const fetch = this.fetchImpl || (this.systemFetch && this.useSystemNetwork() ? this.systemFetch : null);
    const client = fetch ? null : createUpstreamFetch(this.root);
    try { return await operation(fetch || client.fetch); } finally { await client?.close(); }
  }
  async check() {
    if (this.pending || ['ready', 'installing'].includes(this.state.phase)) return this.snapshot();
    if (this.installErrorPending) { this.installErrorPending = false; return this.snapshot(); }
    this.emit({ phase: 'checking', error: '' });
    this.pending = this.connection(async fetch => {
      const response = await fetch(api, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'easy-switch-desktop' }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Unable to check GitHub updates.'); }
      this.release = selectRelease(await response.json(), this.current, this.platform, this.arch);
      this.emit({ phase: this.release ? 'available' : 'current', version: this.release?.version || '', checkedAt: Date.now() });
    }).catch(error => this.emit({ phase: 'error', failedAction: 'check', error: updateError(error, 'check') })).finally(() => { this.pending = null; });
    await this.pending; return this.snapshot();
  }
  async download() {
    if (this.pending) return this.pending;
    if (!this.release) throw new Error('Check for an update first.');
    const release = this.release, target = path.join(this.directory, release.asset.name);
    this.emit({ phase: 'downloading', received: 0, total: release.asset.size, error: '' });
    this.pending = this.connection(async fetch => {
      let last = 0;
      await downloadPackage(fetch, release.asset, target, (received, total) => { if (Date.now() - last > 150) { last = Date.now(); this.emit({ received, total }); } });
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
    }).catch(error => { const message = updateError(error, 'download'); this.emit({ phase: 'error', failedAction: 'download', error: message }); throw new Error(message); }).finally(() => { this.pending = null; });
    return this.pending;
  }
  async verifiedWindowsInstaller() {
    if (!this.canRevealInstaller) throw new Error('Download and verify the update first.');
    const file = this.staged, { size, sha256 } = this.release.asset;
    let verified = false;
    try {
      const info = fs.lstatSync(file);
      if (info.isFile() && info.size === size) {
        const hash = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
        verified = hash.digest('hex') === sha256;
      }
    } catch { /* A missing or unreadable installer also needs a new download. */ }
    if (!this.canRevealInstaller || this.staged !== file) throw new Error('Download and verify the update first.');
    if (!verified) {
      const error = 'Update package SHA-256 verification failed.';
      this.staged = null;
      this.emit({ phase: 'error', failedAction: 'download', error });
      throw new Error(error);
    }
    return file;
  }
  confirmLaunch() {
    if (!fs.existsSync(this.receipt)) return;
    const pending = JSON.parse(fs.readFileSync(this.receipt, 'utf8'));
    const normalize = value => this.platform === 'win32' ? path.win32.resolve(value).toLowerCase() : path.resolve(value);
    if (pending.version !== this.current || pending.executable && normalize(pending.executable) !== normalize(process.execPath)) return;
    atomic(this.receipt, { ...pending, ready: true });
    if (pending.nativeHelper) fs.writeFileSync(path.join(this.directory, 'app-ready.txt'), pending.token, { mode: 0o600 });
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
      const staged = await this.verifiedWindowsInstaller();
      const installed = fs.realpathSync(path.dirname(executable));
      const relative = path.relative(installed, fs.realpathSync(this.directory));
      if (!relative || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)) {
        throw new Error('The easy-switch data directory is inside its installation folder. Move it before updating.');
      }
      const token = crypto.randomUUID(); atomic(this.receipt, { version, token, executable, ready: false, nativeHelper: true });
      try {
        await startWindowsUpdate({ parent: process.pid, current: executable, staged, receipt: this.receipt, version, token,
          environment: { SWITCH_HOME: this.root, CODEX_HOME: codexHome } }, path.join(process.resourcesPath, 'windows-update.exe'));
      } catch (error) { fs.rmSync(this.receipt, { force: true }); throw error; }
    }
    this.emit({ phase: 'installing' });
  }
}
