import fs from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { parse } from 'smol-toml';
import { checkpoint, expandContext } from './compaction.js';
import { digest, maxPackage, syncID } from './sync-storage.js';
import { resolveCodexExecutable, type CodexExecutable } from './codex-binary.js';

export interface CodexTask {
  id: string; title: string; cwd: string; path: string; provider?: string; updatedAt: number; archived: boolean;
}
interface CodexThread {
  id: string; name?: string; preview?: string; cwd: string; path: string; modelProvider?: string; updatedAt: number;
}
export interface SessionHistory {
  hash: string; contentHash?: string; legacyHash?: string; workspaceRepair?: boolean; providerRepair?: boolean;
  records: { type: string; payload?: Record<string, unknown> }[];
  sessionFiles?: { name: string; records: unknown[] }[];
  timestamp: string; attachments?: { name: string; data: string }[];
}
interface CachedHistory {
  size: number; mtime: number; ctime: number; root: string; history: SessionHistory;
}
type CodexRpc = <Result = unknown>(method: string, params: object) => Promise<Result>;
type WriteHistory<T> = (signal?: AbortSignal) => T | Promise<T>;
export interface CodexConfigResult {
  config: { sqlite_home?: string };
  layers?: { name: { type: string; profile?: string }; version: string }[];
}

const fluidProvider = 'fluid';
const execute = promisify(execFile);

async function updateIndexedProvider(database, id, provider, signal) {
  if (!fs.statSync(database, { throwIfNoEntry: false })?.isFile()) return;
  const { DatabaseSync } = await import('node:sqlite').catch(error => {
    if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error;
    return { DatabaseSync: undefined };
  });
  signal?.throwIfAborted();
  const sql = 'UPDATE threads SET model_provider = $provider WHERE id = $id AND model_provider IS NOT $provider';
  if (!DatabaseSync) {
    // The desktop bundles Node's SQLite module. Older supported CLI runtimes can use sqlite3.
    const literal = text => "CAST(X'" + Buffer.from(text).toString('hex') + "' AS TEXT)";
    const statement = sql.replaceAll('$provider', literal(provider)).replaceAll('$id', literal(id));
    await execute('sqlite3', ['-batch', '-bail', '-init', devNull, '-cmd', '.timeout 1000', database, statement], { signal, timeout: 5000, windowsHide: true })
      .catch(error => {
        if (error.code === 'ENOENT') throw new Error('Codex provider repair requires sqlite3 or Node.js 22.13+.');
        throw error;
      });
    return;
  }
  const db = new DatabaseSync(database);
  try {
    db.exec('PRAGMA busy_timeout = 100');
    db.prepare(sql).run({ $provider: provider, $id: id });
  } finally { db.close(); }
}

function providerFields(records, id) {
  const fields = new Map();
  for (const { type, payload } of records) {
    if (type === 'session_meta' && payload?.id === id) fields.set(payload, 'model_provider');
    if (type === 'event_msg' && payload?.type === 'thread_settings_applied' &&
        (payload.thread_id == null || payload.thread_id === id) && payload.thread_settings) {
      fields.set(payload.thread_settings, 'model_provider_id');
    }
  }
  return fields;
}

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
export async function codexSession<T>({ binary, codexHome, signal }: { binary: CodexExecutable; codexHome: string; signal?: AbortSignal }, operation: (call: CodexRpc) => T | Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  const child = spawn(resolveCodexExecutable(binary), ['app-server', '--stdio'], { env: { ...process.env, CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
  const call: CodexRpc = (method, params) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject, method }); child.stdin.write(JSON.stringify({ id: n, method, params }) + '\n'); });
  try {
    await call('initialize', { clientInfo: { name: 'fluid_sync', version: '1.0.0' }, capabilities: { experimentalApi: true } });
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

function taskMetadata(thread: CodexThread, archived: boolean): CodexTask {
  return { id: thread.id, title: thread.name || thread.preview || thread.id, cwd: thread.cwd, path: thread.path,
    provider: thread.modelProvider, updatedAt: thread.updatedAt * 1000, archived };
}

export async function withWindowsWriter<T>(codexHome: string, ids: string[], signal: AbortSignal, operation: WriteHistory<T>, run = spawn) {
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

async function withPosixWriter<T>(codexHome: string, ids: string[], signal: AbortSignal, operation: WriteHistory<T>) {
  signal?.throwIfAborted();
  const directory = path.join(codexHome, 'thread-writer-locks');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const locks = [];
  // The parent retains the open file description after the locking command exits.
  const [command, args] = process.platform === 'darwin'
    ? ['/usr/bin/perl', ['-MFcntl=:flock', '-e', 'exit(flock(STDIN, LOCK_EX | LOCK_NB) ? 0 : $!{EWOULDBLOCK} ? 75 : 1)']]
    : ['flock', ['-n', '-E', '75', '0']];
  const acquire = async (name, attempts) => {
    const fd = fs.openSync(path.join(directory, name), 'a+', 0o600);
    locks.push(fd);
    for (let attempt = 0; attempt < attempts; attempt++) {
      signal?.throwIfAborted();
      const child = spawn(command, args, { stdio: [fd, 'ignore', 'ignore'], signal });
      const [code] = await once(child, 'close').catch(error => {
        signal?.throwIfAborted();
        throw new Error('Unable to acquire the Codex history lock.', { cause: error });
      });
      if (code === 0) return fd;
      if (code !== 75) throw new Error('Unable to acquire the Codex history lock.');
      if (attempt + 1 < attempts) await delay(50, undefined, { signal });
    }
    throw writerBusy();
  };
  try {
    const coordination = await acquire('.coordination.lock', 20);
    for (const id of ids) await acquire(id + '.lock', 1);
    fs.closeSync(coordination); locks.shift();
    signal?.throwIfAborted();
    return await operation(signal);
  } finally { for (const fd of locks) fs.closeSync(fd); }
}

export class CodexTasks {
  declare binary: CodexExecutable;
  declare codexHome: string;
  declare token: () => string;
  declare platform: NodeJS.Platform;
  declare cache: Map<string, CachedHistory>;

  constructor({ binary, codexHome, token, platform = process.platform }: { binary: CodexExecutable; codexHome: string; token: () => string; platform?: NodeJS.Platform }) { Object.assign(this, { binary, codexHome, token, platform }); this.cache = new Map(); }
  routingProvider() {
    try {
      const config = parse(fs.readFileSync(path.join(this.codexHome, 'config.toml'), 'utf8'));
      const url = (config.model_providers as Record<string, { base_url?: string }>)?.[fluidProvider]?.base_url;
      if (config.model_provider === fluidProvider && /^http:\/\/127\.0\.0\.1:\d+\/v1\/?$/.test(url || '')) {
        return fluidProvider;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Unable to read Codex routing configuration.');
    }
  }
  contentHash(records, _sessionFiles?: SessionHistory['sessionFiles']) {
    const fields = providerFields(records, records[0]?.payload?.id);
    // The stored revision still carries the provider for compatibility with older clients.
    return digest(JSON.stringify(records, function (key, value) {
      if ((key === 'model_provider' || key === 'model_provider_id') && fields.get(this) === key) return undefined;
      return value;
    }));
  }
  async list(signal?: AbortSignal) {
    return codexSession({ ...this, signal }, async call => {
      const threads = new Map<string, CodexTask>();
      for (const archived of [false, true]) {
        let cursor, count = 0;
        do {
          const page = await call<{ data: CodexThread[]; nextCursor?: string }>('thread/list', { archived, cursor, limit: 100, modelProviders: [], sortKey: 'updated_at' });
          for (const thread of page.data) if (thread.path && thread.cwd) {
            const previous = threads.get(thread.id);
            if (!previous || !fs.existsSync(previous.path)) threads.set(thread.id, taskMetadata(thread, archived));
          }
          count += page.data.length; cursor = page.nextCursor;
        } while (cursor && count < 5000);
      }
      return [...threads.values()];
    });
  }
  async find(ids: string[], signal?: AbortSignal) {
    return codexSession({ ...this, signal }, async call => {
      const tasks: CodexTask[] = [];
      const archived = path.resolve(this.codexHome, 'archived_sessions');
      const prefixes = fs.existsSync(archived) ? [archived, fs.realpathSync(archived)] : [archived];
      for (const threadId of ids) {
        const result = await call<{ thread: CodexThread }>('thread/read', { threadId, includeTurns: false }).catch(error => {
          if (error.cause?.code !== -32600 || !/^(?:thread not loaded|no rollout found)/i.test(error.cause.message)) throw error;
          return undefined;
        });
        const thread = result?.thread;
        if (thread?.path && thread.cwd) tasks.push(taskMetadata(thread, prefixes.some(directory => {
          const relative = path.relative(directory, thread.path);
          return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
        })));
      }
      return tasks;
    });
  }
  async withWriter<T>(task: Pick<CodexTask, 'id'> | Pick<CodexTask, 'id'>[], signal: AbortSignal, operation: WriteHistory<T>) {
    const ids = [...new Set((Array.isArray(task) ? task : [task]).filter(Boolean).map(task => task.id))];
    if (!ids.length) return operation(signal);
    if (ids.some(id => !syncID(id))) throw new Error('Invalid synced task ID.');
    // Take Codex's writer locks without loading the thread or opening its rollout.
    return this.platform === 'win32' ? withWindowsWriter(this.codexHome, ids, signal, operation) :
      withPosixWriter(this.codexHome, ids, signal, operation);
  }
  stamp(task: CodexTask) {
    const stat = fs.statSync(task.path);
    return `${task.path}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  }
  read(task: CodexTask, projectRoot = task.cwd): SessionHistory | null {
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
    const savedCwd = meta.payload.cwd;
    const workingDirectory = typeof savedCwd === 'string' && fs.existsSync(savedCwd) ? savedCwd : task.cwd;
    const roots = [...new Set([projectRoot, workingDirectory, fs.realpathSync(projectRoot), fs.realpathSync(workingDirectory)])].sort((a, b) => b.length - a.length);
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
    const history = { records: canonical, hash: digest(JSON.stringify(canonical)), contentHash: this.contentHash(canonical),
      legacyHash: digest(JSON.stringify(legacy)), workspaceRepair: invalidWorkspaceRoots(records),
      providerRepair: [...providerFields(records, task.id)].some(([data, key]) => data[key] !== fluidProvider),
      timestamp: meta.payload.timestamp, attachments: attachments.map(({ name, data }) => ({ name, data })) };
    // Keep only lightweight lookup data; large histories are released after each sync pass.
    if (raw.length + attachments.reduce((size, item) => size + item.data.length, 0) < 1024 * 1024) {
      if (this.cache.size >= 20) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(task.path, { size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs, root: projectRoot, history });
    }
    return history;
  }
  async repair(task: CodexTask, projectRoot: string, signal: AbortSignal, { workspaceRepair, provider }: { workspaceRepair?: boolean; provider?: string } = {}) {
    return this.withWriter(task, signal, async (writerSignal = signal) => {
      if (!this.read(task, projectRoot)) throw writerBusy();
      const raw = fs.readFileSync(task.path, 'utf8'), records = raw.trimEnd().split('\n').map(line => JSON.parse(line));
      const repairRoots = workspaceRepair && invalidWorkspaceRoots(records);
      const fields = provider ? providerFields(records, task.id) : [];
      const providerChanged = [...fields].some(([data, key]) => data[key] !== provider);
      if (repairRoots || providerChanged) {
        for (const [data, key] of fields) data[key] = provider;
        await this.writeRollout(task.id, task.path, repairRoots ? relocateWorkspaceRoots(records, projectRoot) : records, writerSignal);
      }
      if (provider) await this.index({ id: task.id, provider, archived: task.archived }, writerSignal, { repairProvider: true });
    });
  }
  async writeRollout(id, file, records, signal, existing = true) {
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
        if (existing && !fs.existsSync(file)) throw Object.assign(new Error('The Codex task moved during sync. Its location will be refreshed.'), { code: 'SYNC_FILE_BUSY' });
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
    if (['compaction', 'compaction_summary'].includes(value.type) && value.encrypted_content?.startsWith('fluid:v1:')) {
      const message = expandContext([value], fromToken)[0];
      const { encrypted_content, ...item } = value;
      return { ...this.transform(item, paths, fromToken, toToken), syncSummary: this.transform(message.content[0].text, paths, fromToken, toToken) };
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.transform(item, paths, fromToken, toToken)]));
  }
  async install(task: Pick<CodexTask, 'id' | 'title' | 'provider' | 'archived'>, history: SessionHistory, cwd: string, existingPath: string | undefined, signal: AbortSignal, projectRoot = cwd) {
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
    if (task.provider) for (const [data, key] of providerFields(records, task.id)) data[key] = task.provider;
    await this.writeRollout(task.id, file, records, signal, !!existingPath);
    await this.index(task, signal, { repairProvider: !!existingPath });
    return file;
  }
  async index(task: Pick<CodexTask, 'id' | 'provider' | 'archived'> & Partial<Pick<CodexTask, 'title'>>, signal: AbortSignal, { repairProvider = false } = {}) {
    // Codex indexes new imports. An existing paginated thread retains its indexed provider.
    await codexSession({ ...this, signal }, async call => {
      await call('thread/list', { limit: 1, modelProviders: [], archived: !!task.archived });
      // An archived conversation already has a local title. Codex's rename RPC expects an active rollout.
      if (task.title && !task.archived) await call('thread/name/set', { threadId: task.id, name: task.title });
      if (task.provider) {
        const readProvider = async () => (await call<{ thread: CodexThread }>('thread/read', { threadId: task.id, includeTurns: false })).thread.modelProvider;
        if (!repairProvider && await readProvider() === task.provider) return;
        const { config } = await call<CodexConfigResult>('config/read', {});
        const directory = path.resolve(config.sqlite_home || process.env.CODEX_SQLITE_HOME || this.codexHome);
        await updateIndexedProvider(path.join(directory, 'state_5.sqlite'), task.id, task.provider, signal);
        if (await readProvider() !== task.provider) throw new Error('Codex could not update the local provider for this task. Sync will retry.');
      }
    });
  }
}
