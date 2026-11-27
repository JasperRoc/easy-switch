import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, maxPackage } from './sync-storage.js';
import type { CodexTask, SessionHistory } from './sync-codex.js';

const sessionID = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export function claudeProjectKey(directory: string) {
  let source = path.resolve(directory);
  try { source = fs.realpathSync(source); } catch {}
  if (process.platform === 'darwin') source = source.normalize('NFC');
  const key = source.replace(/[^a-zA-Z0-9]/g, '-');
  let hash = 0;
  for (let i = 0; i < source.length; i++) hash = (hash << 5) - hash + source.charCodeAt(i) | 0;
  return key.length <= 200 ? key : key.slice(0, 200) + '-' + Math.abs(hash).toString(36);
}
function relocate(value: unknown, from: string, to: string): any {
  if (typeof value === 'string') {
    if (/^\s*[\[{]/.test(value)) try { return JSON.stringify(relocate(JSON.parse(value), from, to)); } catch {}
    // Encoded JSON tool arguments and ordinary absolute paths both travel across platforms.
    const replaced = value.replaceAll(from, to);
    return to === '$PROJECT' && (value === from || value.startsWith(from + '/') || value.startsWith(from + '\\')) ? replaced.replaceAll('\\', '/') : replaced;
  }
  if (Array.isArray(value)) return value.map(item => relocate(item, from, to));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocate(item, from, to)]));
}
function entries(directory: string) {
  try { return fs.readdirSync(directory, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; return []; }
}
function busy() { return Object.assign(new Error('This Claude Code session is still changing. Sync will retry after the turn finishes.'), { code: 'SYNC_BUSY' }); }

export class ClaudeTasks {
  readonly claudeHome: string;
  readonly metadata = new Map<string, { stamp: string; task: CodexTask }>();
  constructor({ claudeHome }: { claudeHome: string }) { this.claudeHome = claudeHome; }
  async list(signal?: AbortSignal): Promise<CodexTask[]> {
    const root = path.join(this.claudeHome, 'projects'), tasks = new Map<string, CodexTask>();
    for (const folder of entries(root)) {
      signal?.throwIfAborted();
      if (!folder.isDirectory() || folder.isSymbolicLink()) continue;
      for (const file of fs.readdirSync(path.join(root, folder.name), { withFileTypes: true })) {
        const id = file.name.slice(0, -6);
        if (!file.isFile() || !file.name.endsWith('.jsonl') || !sessionID(id)) continue;
        const location = path.join(root, folder.name, file.name), stat = fs.statSync(location);
        const archive = path.join(root, folder.name, id, 'archived.json');
        const archiveStat = fs.statSync(archive, { throwIfNoEntry: false });
        const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${archiveStat?.mtimeMs}:${archiveStat?.ctimeMs}`;
        const cached = this.metadata.get(location);
        if (cached?.stamp === stamp) { if (!tasks.has(id) || cached.task.updatedAt > tasks.get(id).updatedAt) tasks.set(id, cached.task); continue; }
        // Listing stays bounded even when a selected transcript contains hundreds of megabytes.
        const fd = fs.openSync(location, 'r'), limit = 65536;
        let raw: string;
        try {
          const head = Buffer.alloc(Math.min(stat.size, limit)); fs.readSync(fd, head, 0, head.length, 0);
          if (stat.size > limit) {
            const tail = Buffer.alloc(Math.min(stat.size, limit)); fs.readSync(fd, tail, 0, tail.length, stat.size - tail.length);
            const end = tail.toString('utf8'); raw = head.subarray(0, head.lastIndexOf(10) + 1).toString('utf8') + end.slice(end.indexOf('\n') + 1);
          } else raw = head.toString('utf8');
        } finally { fs.closeSync(fd); }
        const records: any[] = raw.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
        const messages = records.filter(record => record.sessionId === id && !record.isSidechain);
        const cwd = messages.findLast(record => typeof record.cwd === 'string')?.cwd;
        if (!cwd || !messages.some(record => ['user', 'assistant'].includes(record.type))) continue;
        const first = messages.find(record => record.type === 'user' && !record.isMeta)?.message?.content;
        const preview = typeof first === 'string' ? first : first?.find(item => item.type === 'text')?.text;
        const title = messages.findLast(record => record.type === 'custom-title')?.customTitle || messages.findLast(record => record.type === 'ai-title')?.aiTitle || preview || id;
        let archived = false;
        try {
          const mark = JSON.parse(fs.readFileSync(archive, 'utf8'));
          archived = mark.archived === true && !messages.some(record => record.type === 'user' && !record.isMeta &&
            !record.message?.content?.some?.(item => item.type === 'tool_result') && Date.parse(record.timestamp) > Date.parse(mark.at));
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const task = { id, title: String(title).slice(0, 300), cwd, path: location, updatedAt: stat.mtimeMs, archived };
        this.metadata.set(location, { stamp, task });
        if (!tasks.has(id) || task.updatedAt > tasks.get(id).updatedAt) tasks.set(id, task);
      }
    }
    for (const file of this.metadata.keys()) if (!fs.existsSync(file)) this.metadata.delete(file);
    return [...tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async find(ids: string[], signal?: AbortSignal) { return (await this.list(signal)).filter(task => ids.includes(task.id)); }
  stamp(task: CodexTask) {
    const stat = fs.statSync(task.path);
    const agents = path.join(path.dirname(task.path), task.id, 'subagents');
    return `${task.path}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:` + entries(agents).filter(entry => entry.isFile()).sort((a,b) => a.name.localeCompare(b.name)).map(entry => {
      const info = fs.statSync(path.join(agents, entry.name)); return `${entry.name}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    }).join('|');
  }
  contentHash(records: SessionHistory['records'], sessionFiles: SessionHistory['sessionFiles'] = []) { return digest(JSON.stringify([records, sessionFiles])); }
  read(task: CodexTask, projectRoot = task.cwd): SessionHistory | null {
    const before = this.stamp(task), stat = fs.statSync(task.path);
    if (stat.size > maxPackage / 2) throw new Error('This task history exceeds the 128 MiB sync limit.');
    const raw = fs.readFileSync(task.path, 'utf8');
    if (!raw.endsWith('\n') || Date.now() - stat.mtimeMs < 2000) return null;
    const records: any[] = raw.trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line));
    if (!records.some(record => record.sessionId === task.id && record.type === 'user')) throw new Error('Invalid synced Claude Code history.');
    const last = records.findLast(record => ['user', 'assistant'].includes(record.type) && !record.isSidechain);
    if (last?.type === 'user' || last?.message?.content?.some?.(item => item.type === 'tool_use') && last.message.stop_reason !== 'end_turn') return null;
    const pendingTools = new Set<string>();
    for (const record of records) {
      if (record.type === 'system' && record.subtype === 'compact_boundary') pendingTools.clear();
      if (!Array.isArray(record.message?.content)) continue;
      for (const item of record.message.content) {
        if (item.type === 'tool_use') pendingTools.add(item.id);
        if (item.type === 'tool_result') pendingTools.delete(item.tool_use_id);
      }
    }
    if (pendingTools.size) return null;
    const transform = (data: unknown) => relocate(data, projectRoot, '$PROJECT');
    const canonical = records.filter(record => !['bridge-session', 'api-request', 'api-request-blob', 'api-request-shape'].includes(record.type)).map(transform);
    const sessionFiles: { name: string; records: any[] }[] = [];
    let total = stat.size;
    const agents = path.join(path.dirname(task.path), task.id, 'subagents');
    for (const entry of entries(agents)) {
      if (!entry.isFile() || !/^agent-[a-zA-Z0-9_-]+\.jsonl$/.test(entry.name)) continue;
      const file = path.join(agents, entry.name), info = fs.statSync(file);
      total += info.size;
      if (total > maxPackage / 2) throw new Error('This task history exceeds the 128 MiB sync limit.');
      const contents = fs.readFileSync(file, 'utf8');
      if (!contents.endsWith('\n') || Date.now() - info.mtimeMs < 2000) return null;
      sessionFiles.push({ name: entry.name, records: contents.trimEnd().split('\n').filter(Boolean).map(line => transform(JSON.parse(line))) });
    }
    if (this.stamp(task) !== before) return null;
    sessionFiles.sort((a,b) => a.name.localeCompare(b.name));
    const contentHash = this.contentHash(canonical, sessionFiles);
    return { records: canonical, contentHash, hash: contentHash, timestamp: records.find(record => record.timestamp)?.timestamp || new Date(stat.birthtimeMs).toISOString(), sessionFiles };
  }
  async withWriter<T>(tasks: Pick<CodexTask, 'id'> | Pick<CodexTask, 'id'>[], signal: AbortSignal, operation: (signal?: AbortSignal) => T | Promise<T>): Promise<T> {
    const ids = new Set((Array.isArray(tasks) ? tasks : [tasks]).map(task => task.id));
    for (const entry of entries(path.join(this.claudeHome, 'sessions'))) {
      if (!entry.isFile() || !/^\d+\.json$/.test(entry.name)) continue;
      let session;
      try { session = JSON.parse(fs.readFileSync(path.join(this.claudeHome, 'sessions', entry.name), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!ids.has(session.sessionId) || !Number.isInteger(session.pid) || session.pid <= 0) continue;
      try { process.kill(session.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') continue; throw error; }
      throw Object.assign(new Error('This session is open in Claude Code. Close it to apply the incoming revision.'), { code: 'SYNC_BUSY' });
    }
    signal.throwIfAborted(); return operation(signal);
  }
  async install(task: Pick<CodexTask, 'id' | 'title' | 'archived'>, history: SessionHistory, cwd: string, existing: string | undefined, signal: AbortSignal, projectRoot = cwd) {
    signal?.throwIfAborted();
    if (!sessionID(task.id) || !history.records.some((record: any) => record.sessionId === task.id && record.type === 'user')) throw new Error('Invalid synced Claude Code history.');
    for (const agent of history.sessionFiles || []) if (!/^agent-[a-zA-Z0-9_-]+\.jsonl$/.test(agent.name) || !Array.isArray(agent.records)) throw new Error('Invalid Claude Code subagent history.');
    const directory = path.join(this.claudeHome, 'projects', claudeProjectKey(cwd));
    const file = existing || path.join(directory, task.id + '.jsonl');
    const relative = path.relative(path.join(this.claudeHome, 'projects'), file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || path.basename(file) !== task.id + '.jsonl') throw new Error('Task history is outside the Claude Code session directory.');
    if (existing) {
      if (!this.read({ ...task, cwd, path: existing, updatedAt: 0, archived: !!task.archived }, projectRoot)) throw busy();
      const backup = path.join(this.claudeHome, 'sync-backups', task.id + '.jsonl');
      fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 }); fs.copyFileSync(file, backup); fs.chmodSync(backup, 0o600);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const allowed = fs.realpathSync(path.join(this.claudeHome, 'projects'));
    const actual = path.relative(allowed, fs.realpathSync(path.dirname(file)));
    if (actual.startsWith('..') || path.isAbsolute(actual) || fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Task history is outside the Claude Code session directory.');
    const write = (target: string, records: unknown[]) => {
      const temp = target + '.' + randomUUID() + '.tmp';
      try {
        let parent = path.dirname(target);
        while (!fs.existsSync(parent)) parent = path.dirname(parent);
        const relative = path.relative(allowed, fs.realpathSync(parent));
        if (relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Task history is outside the Claude Code session directory.');
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.writeFileSync(temp, records.map(record => JSON.stringify(relocate(record, '$PROJECT', projectRoot))).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
        signal?.throwIfAborted(); fs.renameSync(temp, target);
        const timestamp = new Date(Date.now() - 2100); fs.utimesSync(target, timestamp, timestamp);
      } finally { fs.rmSync(temp, { force: true }); }
    };
    for (const agent of history.sessionFiles || []) {
      write(path.join(path.dirname(file), task.id, 'subagents', agent.name), agent.records);
    }
    write(file, history.records);
    return file;
  }
}
