import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { checkImmutable, digest, maxPackage, syncFile, syncReference, type RevisionStorage, type StorageReference } from './sync-storage.js';


const nonce = () => randomBytes(16).toString('hex');
const sftp = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'sftp.exe') : 'sftp';
const missingFile = /^File "[^\r\n]*" not found\.\r?$/m;
const failedDelete = /^remote delete [^\r\n]*: (?!No such file or directory\r?$)/im;

export function sshDestination(input: string) {
  const host = typeof input === 'string' && input.trim();
  if (!host || host.length > 320 || !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(host))
    throw new Error('Enter an SSH alias or a username@hostname.');
  return host;
}

function connectionError(error, stderr) {
  if (error.code === 'ENOENT') return new Error('Install the OpenSSH client to use SSH task sync.');
  if (error.name === 'AbortError') return new Error('The SSH transfer timed out. Check the connection and retry.');
  if (/host key verification failed|no .* host key is known|remote host identification has changed/i.test(stderr))
    return new Error('Verify the SSH host in your terminal before connecting.');
  if (/permission denied \(|authentication failed|too many authentication failures/i.test(stderr))
    return new Error('SSH sign-in failed. Set up a key or SSH agent on this computer.');
  if (/subsystem request failed/i.test(stderr)) return new Error('Enable SFTP for this SSH account.');
  return new Error('Unable to sync over SSH. Check that the host is reachable and the account can write to its home folder.');
}

export class SshSyncStorage implements RevisionStorage {
  readonly target: string;
  readonly library: string;

  constructor(target: string, namespace = '') {
    if (!['', 'claude'].includes(namespace)) throw new Error('Invalid sync namespace.');
    this.target = sshDestination(target); this.library = '.fluid-sync' + (namespace ? '/' + namespace : '');
  }
  async batch(commands: string[], { cwd, signal, missing = false, download, deleting = false }: {
    cwd?: string; signal?: AbortSignal; missing?: boolean; download?: string; deleting?: boolean;
  } = {}): Promise<string | null> {
    signal?.throwIfAborted();
    const limit = new AbortController();
    const abort = AbortSignal.any([limit.signal, AbortSignal.timeout(120000), ...(signal ? [signal] : [])]);
    let oversized = false;
    const timer = download && setInterval(async () => {
      const stat = await fs.stat(path.join(cwd, download)).catch(() => null);
      if (stat?.size > maxPackage) { oversized = true; limit.abort(); }
    }, 150);
    try {
      return await new Promise((resolve, reject) => {
        const child = execFile(sftp, ['-b', '-', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
          '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2', this.target],
        { cwd, signal: abort, env: { ...process.env, LC_ALL: 'C' }, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (!error) {
            if (deleting && failedDelete.test(stderr)) return reject(new Error('SSH could not remove the remote sync files. Check the folder permissions.'));
            return resolve(stdout);
          }
          if (signal?.aborted) return reject(signal.reason);
          if (oversized) return reject(new Error('Sync data exceeds 256 MiB.'));
          if (missing && error.code === 1 && missingFile.test(stderr)) return resolve(null);
          reject(connectionError(error, stderr));
        });
        child.stdin.on('error', () => {}); // The command callback reports a failed connection.
        child.stdin.end(commands.map(command => '@' + command).join('\n') + '\n');
      });
    } finally { clearInterval(timer); }
  }
  async initialize(signal?: AbortSignal) {
    await this.batch([
      '-mkdir .fluid-sync', '-mkdir ' + this.library, 'cd ' + this.library, 'chmod 700 .',
      '-mkdir refs', '-mkdir objects', 'chmod 700 refs', 'chmod 700 objects',
    ], { signal });
    const probe = `refs/probe_${nonce()}.bin`;
    try { await this.putImmutable(probe, Buffer.from('fluid SSH sync verification'), signal); }
    finally { await this.batch(['-rm ' + this.library + '/' + probe], { signal }).catch(() => {}); }
  }
  async references(signal?: AbortSignal): Promise<StorageReference[]> {
    const output = await this.batch(['cd ' + this.library + '/refs', 'ls -1'], { signal });
    return [...new Set(output.split(/\r?\n/))].map(name => syncReference(name)).filter(Boolean);
  }
  async get(name: string, signal?: AbortSignal) {
    if (!syncFile.test(name)) throw new Error('Invalid sync object path.');
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'fluid-sftp-'));
    try {
      const saved = await this.batch([`get ${this.library}/${name} received`], { cwd, signal, missing: true, download: 'received' });
      if (saved === null) return null;
      const file = path.join(cwd, 'received');
      if ((await fs.stat(file)).size > maxPackage) throw new Error('Sync data exceeds 256 MiB.');
      return { data: await fs.readFile(file), etag: null };
    } finally { await fs.rm(cwd, { recursive: true, force: true }); }
  }
  async removeFiles(names: string[], signal?: AbortSignal) {
    if (names.some(name => !syncFile.test(name))) throw new Error('Invalid sync object path.');
    if (names.length) await this.batch(names.map(name => `-rm ${this.library}/${name}`), { signal, deleting: true });
  }
  async putImmutable(name: string, data: Buffer, signal?: AbortSignal) {
    checkImmutable(name, data);
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'fluid-sftp-'));
    const destination = this.library + '/' + name, staging = `${path.posix.dirname(destination)}/.upload-${nonce()}`;
    try {
      await fs.writeFile(path.join(cwd, 'send'), data, { mode: 0o600 });
      await this.batch([`put send ${staging}`, `chmod 600 ${staging}`, `get ${staging} received`],
        { cwd, signal, download: 'received' });
      const file = path.join(cwd, 'received');
      if ((await fs.stat(file)).size !== data.length || digest(await fs.readFile(file)) !== digest(data))
        throw new Error('The synchronized file failed its integrity check.');
      try { await this.batch([`rename ${staging} ${destination}`], { signal }); }
      catch (error) {
        const existing = await this.get(name, signal).catch(() => null);
        if (!existing || digest(existing.data) !== digest(data)) throw error;
        await this.batch([`-rm ${staging}`], { signal }).catch(() => {});
      }
    } catch (error) {
      if (!signal?.aborted) await this.batch([`-rm ${staging}`], { signal }).catch(() => {});
      throw error;
    } finally { await fs.rm(cwd, { recursive: true, force: true }); }
  }
}
