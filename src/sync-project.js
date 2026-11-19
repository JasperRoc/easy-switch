import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digest, maxPackage } from './sync-storage.js';

const execute = promisify(execFile);
function stat(file) { try { return fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; } }
async function git(directory, args, options = {}) {
  try { return (await execute('git', ['-c', 'core.hooksPath=' + os.devNull, '-c', 'core.autocrlf=false', '-C', directory, ...args], { encoding: 'utf8', maxBuffer: maxPackage, timeout: 60000, windowsHide: true, ...options })).stdout; }
  catch { throw new Error('Git could not prepare this project. Check Git installation, repository state and file access.'); }
}
async function applyState(project, directory, temp) {
  for (const [name, patch, args] of [['staged', project.staged, ['--index']], ['unstaged', project.unstaged, []]]) {
    if (!patch) continue;
    const file = path.join(temp, name + '.patch'); fs.writeFileSync(file, patch);
    await git(directory, ['apply', '--binary', ...args, file]);
  }
  for (const entry of project.files) {
    const file = inside(directory, entry.name), bytes = Buffer.from(entry.data, 'base64');
    if (stat(file)) throw new Error('An incoming untracked file would overwrite a local file.');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (entry.link) {
      const target = bytes.toString();
      if (path.isAbsolute(target) || !path.resolve(path.dirname(file), target).startsWith(directory + path.sep)) throw new Error('A synced symbolic link points outside its project.');
      fs.symlinkSync(target, file);
    } else fs.writeFileSync(file, bytes, { mode: entry.mode & 0o777, flag: 'wx' });
  }
}
export function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value) ||
      value.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') || /^[a-z]:/i.test(value)) throw new Error('Unsafe project file path in sync data.');
  return value;
}
export function inside(directory, relative) {
  const target = path.join(directory, safeRelative(relative));
  let parent = directory;
  for (const part of relative.split('/').slice(0, -1)) {
    parent = path.join(parent, part);
    if (stat(parent)?.isSymbolicLink()) throw new Error('A project path crosses a symbolic link.');
  }
  return target;
}
export async function projectSnapshot(cwd, cache, withBundle = true) {
  cwd = fs.realpathSync(cwd);
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
  if (/^160000 /m.test(await git(root, ['ls-files', '--stage']))) throw new Error('Task sync currently requires a Git repository without submodules.');
  const staged = await git(root, ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', 'HEAD']);
  const unstaged = await git(root, ['diff', '--binary', '--full-index', '--no-ext-diff']);
  const names = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  const files = []; let size = Buffer.byteLength(staged) + Buffer.byteLength(unstaged);
  if (size > maxPackage / 2) throw new Error('Uncommitted project data exceeds the sync limit.');
  for (const name of names) {
    const file = inside(root, name), stat = fs.lstatSync(file);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('An untracked project entry cannot be synchronized.');
    if (stat.size > 32 * 1024 * 1024) throw new Error('A project file exceeds the 32 MiB sync limit.');
    const data = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(file)) : fs.readFileSync(file);
    size += data.length;
    if (size > maxPackage / 2) throw new Error('Uncommitted project data exceeds the sync limit.');
    files.push({ name, mode: stat.mode & 0o777, link: stat.isSymbolicLink(), data: data.toString('base64') });
  }
  let branch = ''; try { branch = (await git(root, ['symbolic-ref', '--short', 'HEAD'])).trim(); } catch {}
  let origin = ''; try {
    origin = (await git(root, ['remote', 'get-url', 'origin'])).trim();
    if (/^https?:/.test(origin)) { const url = new URL(origin); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; origin = url.href; }
  } catch {}
  const project = { root, head, branch, origin, relative: path.relative(root, cwd).split(path.sep).join('/'), staged, unstaged, files };
  // NTFS and POSIX expose different mode bits for the same untracked file.
  const fingerprint = digest(JSON.stringify({ head, staged, unstaged, files: files.map(({ mode, ...file }) => file) }));
  const bundle = path.join(cache, head + '.bundle');
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(bundle)) {
    const temp = bundle + '.tmp';
    try { await git(root, ['bundle', 'create', temp, 'HEAD']); fs.renameSync(temp, bundle); }
    finally { fs.rmSync(temp, { force: true }); }
  }
  if (fs.statSync(bundle).size > maxPackage / 2) throw new Error('This Git history exceeds the 128 MiB sync limit.');
  return { ...project, fingerprint, ...(withBundle ? { bundle: fs.readFileSync(bundle).toString('base64') } : {}) };
}
export async function restoreProject(project, directory, cache, priorFingerprint) {
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  directory = path.resolve(directory);
  if (!/^[a-f0-9]{40,64}$/.test(project.head || '') || !Array.isArray(project.files) || typeof project.bundle !== 'string') throw new Error('Invalid synced Git project.');
  if (typeof project.relative !== 'string' || path.posix.isAbsolute(project.relative) || project.relative.split('/').includes('..') || project.relative.includes('\\')) throw new Error('Invalid synchronized project directory.');
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('Choose a project folder without a symbolic link.');
  const exists = fs.existsSync(directory) && fs.readdirSync(directory).length > 0;
  let current;
  if (exists) {
    current = await projectSnapshot(directory, cache, false);
    if (fs.realpathSync(current.root) !== fs.realpathSync(directory)) throw new Error('Choose the Git repository root, not a folder inside another project.');
    if (current.fingerprint === project.fingerprint) return directory;
    if (current.fingerprint !== priorFingerprint) throw new Error('Local project changes conflict with the incoming task. Both versions are preserved.');
  } else fs.mkdirSync(directory, { recursive: true });
  const temp = fs.mkdtempSync(path.join(cache, 'restore-'));
  const bundle = path.join(temp, 'project.bundle');
  fs.writeFileSync(bundle, Buffer.from(project.bundle, 'base64'), { mode: 0o600 });
  let validated = false, changing = false;
  try {
    // Validate patches, paths and symlinks in a disposable checkout before touching the user's files.
    const staging = path.join(temp, 'validate'); fs.mkdirSync(staging);
    await git(staging, ['init']); await git(staging, ['bundle', 'verify', bundle]);
    await git(staging, ['fetch', '--no-tags', bundle, 'HEAD']); await git(staging, ['checkout', '--detach', project.head]);
    await applyState(project, staging, temp);
    const incomingState = await projectSnapshot(staging, cache, false);
    if (incomingState.fingerprint !== project.fingerprint) throw new Error('The incoming Git snapshot failed its integrity check.');
    validated = true;
    if (exists) {
      const latest = await projectSnapshot(directory, cache, false);
      if (latest.fingerprint !== current.fingerprint) throw new Error('The local project changed during sync. Retry after this turn finishes.');
      const ignored = (await git(directory, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
      const incoming = [...(await git(staging, ['ls-files', '-z'])).split('\0').filter(Boolean), ...project.files.map(file => file.name)];
      if (ignored.some(local => incoming.some(name => name === local || name.startsWith(local + '/') || local.startsWith(name + '/'))))
        throw new Error('Incoming project files would replace ignored local files. Choose an empty project folder.');
    }
    // Keep a recoverable copy of the previous Git state before replacing managed changes.
    if (current) {
      current.bundle = fs.readFileSync(path.join(cache, current.head + '.bundle')).toString('base64');
      fs.writeFileSync(path.join(cache, 'recovery-' + digest(directory) + '.json'), JSON.stringify(current), { mode: 0o600 });
    }
    if (!exists) await git(directory, ['init']);
    if (!exists && typeof project.origin === 'string' && /^(?:https:\/\/[^\s]+|ssh:\/\/[^\s]+|[\w.-]+@[\w.-]+:[^\s]+)$/.test(project.origin)) await git(directory, ['remote', 'add', 'origin', project.origin]);
    await git(directory, ['bundle', 'verify', bundle]);
    await git(directory, ['fetch', '--no-tags', bundle, 'HEAD']);
    // Never overwrite an unrelated local branch. A detached head holds the synced commit.
    changing = true;
    await git(directory, ['checkout', '--detach', '--force', project.head]);
    if (exists) {
      // Remove only untracked files present in our last known snapshot.
      const tracked = new Set((await git(directory, ['ls-files', '-z'])).split('\0'));
      for (const entry of current.files) {
        if (tracked.has(entry.name)) continue;
        const file = inside(directory, entry.name), now = stat(file);
        if (!now) continue;
        const data = now.isSymbolicLink() ? Buffer.from(fs.readlinkSync(file)) : now.isFile() ? fs.readFileSync(file) : null;
        if (!data || data.toString('base64') !== entry.data || now.isSymbolicLink() !== entry.link) throw new Error('An untracked file changed during sync. The previous project snapshot is retained for recovery.');
        fs.rmSync(file);
      }
    }
    await applyState(project, directory, temp);
    return directory;
  } catch (error) {
    // Keep a failed restore visible and recoverable instead of treating a partial worktree as synced.
    if (validated && changing && current) throw new Error(error.message + ' Previous project data is retained in the private sync recovery cache.');
    throw error;
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
