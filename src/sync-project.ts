import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digest, maxPackage } from './sync-storage.js';

const execute = promisify(execFile);

interface ProjectFile { name: string; mode: number; link: boolean; data: string; }
interface ProjectFiles {
  root: string; relative: string; files: ProjectFile[]; fingerprint: string;
}
interface FolderProject extends ProjectFiles { kind: 'folder'; }
interface GitProject extends ProjectFiles {
  kind?: 'git'; head: string; branch: string; origin: string; staged: string; unstaged: string; bundle?: string;
}
export type ProjectSnapshot = FolderProject | GitProject;
function stat(file) { try { return fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; } }
async function git(directory, args, options = {}) {
  try { return (await execute('git', ['-c', 'core.hooksPath=' + os.devNull, '-c', 'core.autocrlf=false', '-C', directory, ...args], { encoding: 'utf8', maxBuffer: maxPackage, timeout: 60000, windowsHide: true, env: { ...process.env, LC_ALL: 'C' }, ...options })).stdout; }
  catch (cause) { throw new Error('Git could not prepare this project. Check Git installation, repository state and file access.', { cause }); }
}
async function applyState(project: Pick<GitProject, 'staged' | 'unstaged' | 'files'>, directory: string, temp: string) {
  for (const [name, patch, args] of ([['staged', project.staged, ['--index']], ['unstaged', project.unstaged, []]] as const)) {
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
export function inside(directory: string, relative: string) {
  const target = path.join(directory, safeRelative(relative));
  let parent = directory;
  for (const part of relative.split('/').slice(0, -1)) {
    parent = path.join(parent, part);
    if (stat(parent)?.isSymbolicLink()) throw new Error('A project path crosses a symbolic link.');
  }
  return target;
}
function snapshotFiles(root: string, names: string[], size = 0) {
  const files: ProjectFile[] = [];
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
  return files;
}
async function folderSnapshot(root: string, cwd: string, cache: string): Promise<FolderProject> {
  // Git's ignore matcher runs against a private empty repository, never initializing the user's folder.
  const index = path.join(cache, 'folder-index.git');
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(index)) await git(root, ['init', '--bare', index]);
  const names = (await git(root, ['--git-dir=' + index, '--work-tree=' + root, 'ls-files', '--others', '--exclude-standard',
    '--exclude=.git', '--exclude=node_modules', '--exclude=.env', '--exclude=.env.*', '--exclude=.DS_Store', '-z'])).split('\0').filter(Boolean);
  const files = snapshotFiles(root, names), fingerprint = digest(JSON.stringify({ kind: 'folder', files: files.map(({ mode, ...file }) => file) }));
  return { kind: 'folder', root, relative: path.relative(root, cwd).split(path.sep).join('/'), files, fingerprint };
}
export async function projectSnapshot(cwd: string, cache: string, withBundle = true): Promise<ProjectSnapshot> {
  cwd = fs.realpathSync.native(cwd);
  let root, head;
  try { root = fs.realpathSync.native((await git(cwd, ['rev-parse', '--show-toplevel'])).trim()); }
  catch (error) {
    if (error.cause?.code === 128 && /not a git repository/i.test(error.cause.stderr || '')) return folderSnapshot(cwd, cwd, cache);
    throw error;
  }
  try { head = (await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])).trim(); }
  catch (error) { if (error.cause?.code === 1) return folderSnapshot(root, cwd, cache); throw error; }
  const [entries, staged, unstaged, untracked, branch, remote] = await Promise.all([
    git(root, ['ls-files', '--stage']),
    git(root, ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', 'HEAD']),
    git(root, ['diff', '--binary', '--full-index', '--no-ext-diff']),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
    git(root, ['symbolic-ref', '--short', 'HEAD']).catch(() => ''),
    git(root, ['remote', 'get-url', 'origin']).catch(() => ''),
  ]);
  if (/^160000 /m.test(entries)) throw new Error('Task sync currently requires a Git repository without submodules.');
  const files = snapshotFiles(root, untracked.split('\0').filter(Boolean), Buffer.byteLength(staged) + Buffer.byteLength(unstaged));
  let origin = remote.trim();
  if (/^https?:/.test(origin)) { const url = new URL(origin); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; origin = url.href; }
  const project = { root, head, branch: branch.trim(), origin, relative: path.relative(root, cwd).split(path.sep).join('/'), staged, unstaged, files };
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
async function restoreFolder(project: FolderProject, directory: string, cache: string, priorFingerprint?: string) {
  if (!Array.isArray(project.files)) throw new Error('Invalid synced folder.');
  const exists = fs.existsSync(directory) && fs.readdirSync(directory).length > 0;
  const current = exists ? await projectSnapshot(directory, cache, false) : null;
  if (current && (current.kind !== 'folder' || fs.realpathSync.native(current.root) !== fs.realpathSync.native(directory))) throw new Error('Choose an empty folder or the original non-Git project folder.');
  if (current?.fingerprint === project.fingerprint) return directory;
  if (current && current.fingerprint !== priorFingerprint) throw new Error('Local project changes conflict with the incoming task. Both versions are preserved.');
  const temp = fs.mkdtempSync(path.join(cache, 'restore-folder-'));
  let changing = false;
  try {
    const staging = path.join(temp, 'validate'); fs.mkdirSync(staging);
    await applyState({ ...project, staged: '', unstaged: '' }, staging, temp);
    if ((await folderSnapshot(staging, staging, cache)).fingerprint !== project.fingerprint) throw new Error('The incoming folder snapshot failed its integrity check.');
    const managed = new Set(current?.files.map(file => file.name));
    for (const entry of project.files) {
      const file = inside(directory, entry.name);
      if (stat(file) && !managed.has(entry.name)) throw new Error('Incoming project files would replace ignored local files. Choose an empty project folder.');
      let parent = path.dirname(file);
      while (parent !== directory) {
        const value = stat(parent);
        if (value && !value.isDirectory()) throw new Error('An incoming folder path is blocked by a local file.');
        parent = path.dirname(parent);
      }
    }
    if (current) {
      if ((await projectSnapshot(directory, cache, false)).fingerprint !== current.fingerprint) throw new Error('The local project changed during sync. Retry after this turn finishes.');
      fs.writeFileSync(path.join(cache, 'recovery-' + digest(directory) + '.json'), JSON.stringify(current), { mode: 0o600 });
    }
    fs.mkdirSync(directory, { recursive: true }); changing = true;
    for (const entry of current?.files || []) fs.rmSync(inside(directory, entry.name));
    await applyState({ ...project, staged: '', unstaged: '' }, directory, temp);
    return directory;
  } catch (error) {
    if (changing && current) throw new Error(error.message + ' Previous project data is retained in the private sync recovery cache.');
    throw error;
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
export async function restoreProject(project: ProjectSnapshot, directory: string, cache: string, priorFingerprint?: string) {
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  directory = path.resolve(directory);
  if (typeof project.relative !== 'string' || path.posix.isAbsolute(project.relative) || project.relative.split('/').includes('..') || project.relative.includes('\\')) throw new Error('Invalid synchronized project directory.');
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('Choose a project folder without a symbolic link.');
  if (project.kind === 'folder') return restoreFolder(project, directory, cache, priorFingerprint);
  if (!/^[a-f0-9]{40,64}$/.test(project.head || '') || !Array.isArray(project.files) || typeof project.bundle !== 'string') throw new Error('Invalid synced Git project.');
  const exists = fs.existsSync(directory) && fs.readdirSync(directory).length > 0;
  let current;
  if (exists) {
    current = await projectSnapshot(directory, cache, false);
    if (fs.realpathSync.native(current.root) !== fs.realpathSync.native(directory)) throw new Error('Choose the Git repository root, not a folder inside another project.');
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
      const incoming = [...(await git(staging, ['ls-files', '-z'])).split('\0').filter(Boolean), ...project.files.map(file => file.name)];
      if (current.kind === 'folder') {
        const managed = new Set(current.files.map(file => file.name));
        if (incoming.some(name => stat(inside(directory, name)) && !managed.has(name))) throw new Error('Incoming project files would replace ignored local files. Choose an empty project folder.');
      } else {
        const ignored = (await git(directory, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
        if (ignored.some(local => incoming.some(name => name === local || name.startsWith(local + '/') || local.startsWith(name + '/'))))
          throw new Error('Incoming project files would replace ignored local files. Choose an empty project folder.');
      }
    }
    // Keep a recoverable copy of the previous Git state before replacing managed changes.
    if (current) {
      if (current.kind !== 'folder') current.bundle = fs.readFileSync(path.join(cache, current.head + '.bundle')).toString('base64');
      fs.writeFileSync(path.join(cache, 'recovery-' + digest(directory) + '.json'), JSON.stringify(current), { mode: 0o600 });
    }
    if (!exists || current?.kind === 'folder') await git(directory, ['init']);
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
