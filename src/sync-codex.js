import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { checkpoint, expandContext } from './compaction.js';
import { digest, maxPackage, syncID } from './sync-storage.js';

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
    await call('initialize', { clientInfo: { name: 'easy_switch_sync', version: '1.0.0' } });
    child.stdin.write('{"method":"initialized"}\n');
    return await operation(call);
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort); lines.close(); child.stdin.end(); child.kill();
    const force = setTimeout(() => child.kill('SIGKILL'), 1000); await ended; clearTimeout(force);
  }
}
export class CodexTasks {
  constructor({ binary, codexHome, token }) { Object.assign(this, { binary, codexHome, token }); this.cache = new Map(); }
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
  async withWriter(task, signal, operation) {
    const tasks = (Array.isArray(task) ? task : [task]).filter(Boolean);
    if (!tasks.length) return operation();
    return codexSession({ ...this, signal }, async call => {
      try { for (const task of tasks) await call('thread/resume', { threadId: task.id, excludeTurns: true }); }
      catch (error) {
        if (/active writer|already.*(?:loaded|running)/i.test(error.cause?.message || '')) {
          const busy = new Error('This task is open in Codex. Its incoming revision will be applied when Codex releases it.'); busy.code = 'SYNC_BUSY'; throw busy;
        }
        throw error;
      }
      return operation();
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
    const canonical = records.map(record => this.transform(record, mappings, this.token(), null));
    const history = { records: canonical, hash: digest(JSON.stringify(canonical)), timestamp: meta.payload.timestamp, attachments: attachments.map(({ name, data }) => ({ name, data })) };
    // Keep only lightweight lookup data; large histories are released after each sync pass.
    if (raw.length + attachments.reduce((size, item) => size + item.data.length, 0) < 1024 * 1024) {
      if (this.cache.size >= 20) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(task.path, { size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs, root: projectRoot, history });
    }
    return history;
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
    const records = this.transform(history.records, [['$PROJECT', projectRoot], ['$ATTACHMENTS', attachmentRoot]], null, this.token());
    if (records[0]?.type !== 'session_meta' || records[0].payload?.id !== task.id) throw new Error('Invalid synced Codex task history.');
    const text = records.map(record => JSON.stringify(record)).join('\n') + '\n';
    const date = new Date(history.timestamp);
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid synced task creation date.');
    const file = existingPath || path.join(this.codexHome, 'sessions', ...date.toISOString().slice(0, 10).split('-'), `rollout-${date.toISOString().slice(0, 19).replaceAll(':', '-')}-${task.id}.jsonl`);
    const allowed = ['sessions', 'archived_sessions'].some(folder => path.resolve(file).startsWith(path.resolve(this.codexHome, folder) + path.sep) ||
      fs.existsSync(path.join(this.codexHome, folder)) && path.resolve(file).startsWith(fs.realpathSync(path.join(this.codexHome, folder)) + path.sep));
    if (!allowed) throw new Error('Task history is outside the Codex session directory.');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + '.sync.tmp';
    if (existingPath) {
      const backup = path.join(this.codexHome, 'sync-backups', task.id + '.jsonl');
      fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 }); fs.copyFileSync(file, backup); fs.chmodSync(backup, 0o600);
    }
    fs.writeFileSync(temp, text, { mode: 0o600 }); fs.renameSync(temp, file);
    // Let the official client repair its own indexes; never copy/merge its SQLite files.
    await codexSession({ ...this, signal }, async call => {
      await call('thread/list', { limit: 1, modelProviders: [] });
      if (task.title) await call('thread/name/set', { threadId: task.id, name: task.title });
    });
    return file;
  }
}
