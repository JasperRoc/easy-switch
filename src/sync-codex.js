import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { checkpoint, expandContext } from './compaction.js';
import { digest, maxPackage, syncID } from './sync-storage.js';

export function relocateWorkspaceRoots(value, projectRoot) {
  if (Array.isArray(value)) return value.map(item => relocateWorkspaceRoots(item, projectRoot));
  if (!value || typeof value !== 'object') return value;
  const paths = /^[a-z]:[\\/]|^\\\\/i.test(projectRoot) ? path.win32 : path.posix;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (['runtime_workspace_roots', 'runtimeWorkspaceRoots'].includes(key) && Array.isArray(item)) {
      const roots = item.map(root => {
        if (typeof root !== 'string') return projectRoot;
        if (root === '$PROJECT' || root.startsWith('$PROJECT/')) root = paths.join(projectRoot, root.slice('$PROJECT'.length));
        const relative = paths.relative(projectRoot, root);
        const inside = relative === '' || relative !== '..' && !relative.startsWith('..' + paths.sep) && !paths.isAbsolute(relative);
        return inside ? paths.join(projectRoot, relative) : projectRoot;
      });
      return [key, [...new Set(roots)]];
    }
    return [key, relocateWorkspaceRoots(item, projectRoot)];
  }));
}
function invalidWorkspaceRoots(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => ['runtime_workspace_roots', 'runtimeWorkspaceRoots'].includes(key) && Array.isArray(item)
    ? item.some(root => typeof root !== 'string' || (process.platform === 'win32' ? !/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(root) : !path.isAbsolute(root)))
    : invalidWorkspaceRoots(item));
}
export async function codexSession({ binary, codexHome, signal }, operation) {
  signal?.throwIfAborted();
  const child = spawn(binary, ['app-server', '--stdio'], { env: { ...process.env, CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const ended = once(child, 'close').catch(() => {}), pending = new Map(); let id = 0;
  const failure = () => { for (const item of pending.values()) item.reject(new Error('Codex task metadata is unavailable. Check the installed Codex version.')); pending.clear(); };
  child.stderr.resume(); child.on('error', failure); child.on('close', failure); child.stdin.on('error', failure);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const entry = pending.get(message.id); if (!entry) return;
    pending.delete(message.id); message.error ? entry.reject(Object.assign(new Error(`Codex could not load this task (${entry.method}). Check its provider and history compatibility.`), { cause: message.error })) : entry.resolve(message.result);
  });
  const abort = () => { failure(); child.kill(); };
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 30000);
  const call = (method, params) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject, method }); child.stdin.write(JSON.stringify({ id: n, method, params }) + '\n'); });
  try {
    await call('initialize', { clientInfo: { name: 'easy_switch_sync', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write('{"method":"initialized"}\n');
    return await operation(call);
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort); lines.close(); child.stdin.end(); child.kill();
    const force = setTimeout(() => child.kill('SIGKILL'), 1000); await ended; clearTimeout(force);
  }
}
function writerBusy() {
  return Object.assign(new Error('This task is open in Codex. Its incoming revision will be applied when Codex releases it.'), { code: 'SYNC_BUSY' });
}

export async function withWindowsWriter(codexHome, ids, signal, operation, run = spawn) {
  signal?.throwIfAborted();
  if (ids.some(id => !syncID(id))) throw new Error('Invalid synced task ID.');
  const script = fs.readFileSync(new URL('./sync-writer.ps1', import.meta.url), 'utf8');
  const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  child.stdin.on('error', () => {});
  const failure = new Error('Unable to acquire the Codex history lock on Windows.');
  const disconnected = new AbortController();
  const closed = once(child, 'close').catch(() => {}).then(() => { disconnected.abort(failure); return 'closed'; });
  const lines = createInterface({ input: child.stdout });
  const startup = new AbortController();
  const startupSignals = [startup.signal, AbortSignal.timeout(15000)];
  if (signal) startupSignals.push(signal);
  const ready = once(lines, 'line', { signal: AbortSignal.any(startupSignals) }).then(([status]) => status);
  let status;
  try {
    child.stdin.write(Buffer.from(JSON.stringify({ directory: path.join(codexHome, 'thread-writer-locks'), ids })).toString('base64') + '\n');
    status = await Promise.race([ready, closed]);
    if (status === 'busy') throw writerBusy();
    if (status !== 'ready') throw failure;
    const writerSignal = signal ? AbortSignal.any([signal, disconnected.signal]) : disconnected.signal;
    writerSignal.throwIfAborted();
    return await operation(writerSignal);
  } catch (error) {
    signal?.throwIfAborted();
    if (error.name === 'AbortError' && status !== 'ready') throw failure;
    throw error;
  } finally {
    startup.abort(); lines.close(); child.stdin.end();
    if (!status) child.kill();
    await closed;
  }
}

export class CodexTasks {
  constructor({ binary, codexHome, token, platform = process.platform }) { Object.assign(this, { binary, codexHome, token, platform }); this.cache = new Map(); }
  async list(signal) {
    return codexSession({ ...this, signal }, async call => {
      const threads = []; let cursor;
      do {
        const page = await call('thread/list', { cursor, limit: 100, modelProviders: [], sortKey: 'updated_at' });
        threads.push(...page.data); cursor = page.nextCursor;
      } while (cursor && threads.length < 5000);
      return threads.filter(thread => thread.path && thread.cwd).map(thread => ({ id: thread.id, title: thread.name || thread.preview || thread.id, cwd: thread.cwd,
        path: thread.path, provider: thread.modelProvider, updatedAt: thread.updatedAt * 1000 }));
    });
  }
  async withWriter(task, signal, operation, runtimeWorkspaceRoots) {
    const tasks = (Array.isArray(task) ? task : [task]).filter(Boolean);
    if (!tasks.length) return operation(signal);
    // Resuming a rollout opens its JSONL, which Windows can then refuse to replace.
    if (this.platform === 'win32') return withWindowsWriter(this.codexHome, [...new Set(tasks.map(task => task.id))], signal, operation);
    const existing = tasks.filter(task => task.cwd);
    if (!existing.length) return operation(signal);
    return codexSession({ ...this, signal }, async call => {
      try { for (const task of existing) await call('thread/resume', { threadId: task.id, excludeTurns: true, ...(runtimeWorkspaceRoots ? { cwd: task.cwd, runtimeWorkspaceRoots } : {}) }); }
      catch (error) {
        if (/active writer|already.*(?:loaded|running)/i.test(error.cause?.message || '')) {
          throw writerBusy();
        }
        throw error;
      }
      return operation(signal);
    });
  }
  stamp(task) { const stat = fs.statSync(task.path); return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }
  read(task, projectRoot = task.cwd) {
    const stat = fs.statSync(task.path), cached = this.cache.get(task.path);
    if (stat.size > maxPackage / 2) throw new Error('This task history exceeds the 128 MiB sync limit.');
    if (cached?.size === stat.size && cached.mtime === stat.mtimeMs && cached.ctime === stat.ctimeMs && cached.root === projectRoot) return cached.history;
    const raw = fs.readFileSync(task.path, 'utf8');
    const end = raw.lastIndexOf('\n');
    const records = raw.slice(0, end + 1).split('\n').filter(Boolean).map(line => JSON.parse(line));
    const meta = records[0];
    if (meta?.type !== 'session_meta' || meta.payload?.id !== task.id) throw new Error('The Codex task changed while it was being read.');
    let active = false;
    for (const record of records) {
      if (record.type !== 'event_msg') continue;
      if (record.payload?.type === 'task_started') active = true;
      if (['task_complete', 'turn_aborted', 'task_failed'].includes(record.payload?.type)) active = false;
    }
    if (active || raw.length !== end + 1 || fs.statSync(task.path).mtimeMs !== stat.mtimeMs) return null;
    const roots = [...new Set([projectRoot, task.cwd, fs.realpathSync(projectRoot), fs.realpathSync(task.cwd)])].sort((a, b) => b.length - a.length);
    const attachments = [];
    const find = value => {
      if (!value || typeof value !== 'object') return;
      if (['local_image', 'local_file', 'input_file'].includes(value.type)) for (const field of ['path', 'file_path']) {
        const file = value[field];
        if (typeof file !== 'string' || !path.isAbsolute(file) || !fs.existsSync(file)) continue;
        const stat = fs.statSync(file); if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('A task attachment cannot be synchronized.');
        if (!attachments.some(item => item.original === file)) {
          const bytes = fs.readFileSync(file), extension = path.extname(file);
          attachments.push({ original: file, name: digest(bytes) + (/^\.[a-zA-Z0-9]{1,10}$/.test(extension) ? extension : ''), data: bytes.toString('base64') });
        }
      }
      for (const item of Object.values(value)) if (item && typeof item === 'object') Array.isArray(item) ? item.forEach(find) : find(item);
    };
    records.forEach(find);
    const mappings = [...attachments.map(item => [item.original, '$ATTACHMENTS/' + item.name]), ...roots.map(from => {
      const relative = path.relative(fs.realpathSync(projectRoot), fs.realpathSync(from)).split(path.sep).join('/');
      return [from, '$PROJECT' + (relative ? '/' + relative : '')];
    })];
    const legacy = records.map(record => this.transform(record, mappings, this.token(), null)), canonical = relocateWorkspaceRoots(legacy, '$PROJECT');
    const history = { records: canonical, hash: digest(JSON.stringify(canonical)), legacyHash: digest(JSON.stringify(legacy)), workspaceRepair: invalidWorkspaceRoots(records),
      timestamp: meta.payload.timestamp, attachments: attachments.map(({ name, data }) => ({ name, data })) };
    // Keep only lightweight lookup data; large histories are released after each sync pass.
    if (raw.length + attachments.reduce((size, item) => size + item.data.length, 0) < 1024 * 1024) {
      if (this.cache.size >= 20) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(task.path, { size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs, root: projectRoot, history });
    }
    return history;
  }
  async repairWorkspaceRoots(task, projectRoot, signal) {
    return this.withWriter(task, signal, async (writerSignal = signal) => {
      const history = this.read(task, projectRoot);
      if (!history) throw Object.assign(new Error('The local task changed during sync.'), { code: 'SYNC_BUSY' });
      const raw = fs.readFileSync(task.path, 'utf8'), records = raw.trimEnd().split('\n').map(line => JSON.parse(line));
      if (!invalidWorkspaceRoots(records)) return;
      await this.writeRollout(task.id, task.path, relocateWorkspaceRoots(records, projectRoot), writerSignal);
    }, [projectRoot]);
  }
  async writeRollout(id, file, records, signal) {
    signal?.throwIfAborted();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (fs.existsSync(file)) {
      const backup = path.join(this.codexHome, 'sync-backups', id + '.jsonl');
      fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
      fs.copyFileSync(file, backup); fs.chmodSync(backup, 0o600);
    }
    const temp = path.join(path.dirname(file), '.sync-' + randomUUID() + '.tmp');
    try {
      fs.writeFileSync(temp, records.map(record => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        try { fs.renameSync(temp, file); break; }
        catch (error) {
          if (this.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
          if (attempt === 4) throw Object.assign(new Error(`Windows could not replace the Codex history file (${error.code}). Sync will retry automatically.`, { cause: error }), { code: 'SYNC_FILE_BUSY' });
          await delay(100 * (attempt + 1), undefined, { signal });
        }
      }
      this.cache.delete(file);
    } finally { await fs.promises.rm(temp, { force: true }).catch(() => {}); }
  }
  transform(value, paths, fromToken, toToken) {
    if (typeof value === 'string') {
      // Tool arguments can themselves be serialized JSON containing escaped paths.
      if (/^\s*[\[{]/.test(value)) {
        try { return JSON.stringify(this.transform(JSON.parse(value), paths, fromToken, toToken)); } catch {}
      }
      for (const [from, to] of paths) {
        const wasPath = value === from || value.startsWith(from + '/') || value.startsWith(from + '\\');
        value = value.replaceAll(from, to);
        if (wasPath && to.startsWith('$PROJECT')) value = value.replaceAll('\\', '/');
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(item => this.transform(item, paths, fromToken, toToken));
    if (!value || typeof value !== 'object') return value;
    if (['compaction', 'compaction_summary'].includes(value.type) && typeof value.syncSummary === 'string') {
      const { syncSummary, ...item } = value;
      return { ...this.transform(item, paths, fromToken, toToken), encrypted_content: checkpoint(this.transform(syncSummary, paths, fromToken, toToken), toToken).encrypted_content };
    }
    if (['compaction', 'compaction_summary'].includes(value.type) && value.encrypted_content?.startsWith('easy-switch:v1:')) {
      const message = expandContext([value], fromToken)[0];
      const { encrypted_content, ...item } = value;
      return { ...this.transform(item, paths, fromToken, toToken), syncSummary: this.transform(message.content[0].text, paths, fromToken, toToken) };
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.transform(item, paths, fromToken, toToken)]));
  }
  async install(task, history, cwd, existingPath, signal, projectRoot = cwd) {
    if (!syncID(task.id)) throw new Error('Invalid synced task ID.');
    const attachmentRoot = path.join(this.codexHome, 'sync-attachments', task.id);
    for (const attachment of history.attachments || []) {
      if (!/^[a-f0-9]{64}(?:\.[a-zA-Z0-9]{1,10})?$/.test(attachment.name)) throw new Error('Invalid task attachment path.');
      fs.mkdirSync(attachmentRoot, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(attachmentRoot, attachment.name), Buffer.from(attachment.data, 'base64'), { mode: 0o600 });
    }
    const records = relocateWorkspaceRoots(this.transform(history.records, [['$PROJECT', projectRoot], ['$ATTACHMENTS', attachmentRoot]], null, this.token()), projectRoot);
    if (records[0]?.type !== 'session_meta' || records[0].payload?.id !== task.id) throw new Error('Invalid synced Codex task history.');
    const date = new Date(history.timestamp);
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid synced task creation date.');
    const file = existingPath || path.join(this.codexHome, 'sessions', ...date.toISOString().slice(0, 10).split('-'), `rollout-${date.toISOString().slice(0, 19).replaceAll(':', '-')}-${task.id}.jsonl`);
    const allowed = ['sessions', 'archived_sessions'].some(folder => path.resolve(file).startsWith(path.resolve(this.codexHome, folder) + path.sep) ||
      fs.existsSync(path.join(this.codexHome, folder)) && path.resolve(file).startsWith(fs.realpathSync(path.join(this.codexHome, folder)) + path.sep));
    if (!allowed) throw new Error('Task history is outside the Codex session directory.');
    await this.writeRollout(task.id, file, records, signal);
    // Let the official client repair its own indexes; never copy/merge its SQLite files.
    await codexSession({ ...this, signal }, async call => {
      await call('thread/list', { limit: 1, modelProviders: [] });
      if (task.title) await call('thread/name/set', { threadId: task.id, name: task.title });
    });
    return file;
  }
}
