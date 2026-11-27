import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomic, init } from './store.js';
import { createUpstreamFetch, type UpstreamFetch } from './network.js';
import { SyncStorage, syncKey, syncID, seal, unseal, digest } from './sync-storage.js';
import { webdavLibraryURL } from './sync-url.js';
import { CodexTasks, type CodexTask, type SessionHistory } from './sync-codex.js';
import { inside, projectSnapshot, restoreProject, type ProjectSnapshot } from './sync-project.js';
import { SyncJournal, type JournalCache } from './sync-journal.js';
import { SshSyncStorage, sshDestination } from './sync-ssh.js';
import { claudeHome as defaultClaudeHome } from './claude-auth.js';
import { ClaudeTasks } from './sync-claude.js';
import type { Client } from './store.js';
import type { CodexExecutable } from './codex-binary.js';

const storageKinds = ['ssh', 'webdav'];
type StorageKind = 'ssh' | 'webdav';
export interface SyncConnection { kind: StorageKind; url: string; username?: string; }
interface SyncSetup extends SyncConnection { secret?: string; passphrase?: string; enabled?: boolean; }
interface SelectedTask {
  enabled: boolean; generation?: string; revision?: string; historyHash?: string; projectHash?: string;
  providerRepair?: boolean; installingHistoryHash?: string; resolution?: string[];
}
interface SyncConfig extends Omit<Partial<SyncSetup>, 'kind'> {
  kind?: StorageKind | 'server';
  device?: string;
  selected: Record<string, SelectedTask>;
  projects: Record<string, string>;
  claude?: { selected: Record<string, SelectedTask>; projects: Record<string, string> };
}
type TaskStatus = 'off' | 'pending' | 'paused' | 'removed' | 'removing' | 'conflict' | 'running' | 'synced' | 'waitingFile' | 'opened' | 'error';
interface SyncedTask extends Partial<CodexTask> {
  id: string; enabled?: boolean; remote?: boolean; local?: boolean; cleanupPending?: boolean;
  projectKey?: string; status?: TaskStatus; message?: string;
}
interface SyncOptions {
  root: string; client?: Client; claudeHome?: string; codexHome: string; binary: CodexExecutable; fetchImpl?: UpstreamFetch; changed?: () => void; interval?: number;
  tasks?: Pick<CodexTasks, 'list' | 'read' | 'install'> & Partial<Pick<CodexTasks, 'find' | 'contentHash' | 'routingProvider' | 'repair' | 'withWriter' | 'stamp'>>;
  managedSchedule?: boolean;
}
interface HistoryCache {
  stamp: string;
  root: string;
  history: Omit<SessionHistory, 'records' | 'timestamp'>;
}

const hasStorage = (config: SyncConfig) => !!config.url && storageKinds.includes(config.kind);

export class TaskSync {
  declare remoteInitialized?: boolean;
  declare root: string;
  declare client: Client;
  declare codexHome: string;
  declare changed: () => void;
  declare interval: number;
  declare file: string;
  declare cache: string;
  declare projectDirectory: string;
  declare entries: SyncedTask[];
  declare phase: 'idle' | 'syncing' | 'error';
  declare error: string;
  declare lastSynced: number | null;
  declare config: SyncConfig;
  declare fetch: UpstreamFetch;
  declare outbound: ReturnType<typeof createUpstreamFetch> | null;
  declare tasks: SyncOptions['tasks'];
  declare localCache: CodexTask[] | null;
  declare localDirty: boolean;
  declare remoteCache: JournalCache;
  declare historyHashes: Map<string, HistoryCache>;
  declare closed: boolean;
  declare paused: boolean;
  declare metadataTime?: number;
  declare sessionWatchers?: Map<string, fs.FSWatcher>;
  declare timer?: NodeJS.Timeout;
  declare abort?: AbortController;
  declare pending?: Promise<ReturnType<TaskSync['snapshot']>>;
  declare managedSchedule: boolean;

  constructor({ root, client = 'codex', claudeHome = defaultClaudeHome(), codexHome, binary, fetchImpl, tasks, changed = () => {}, interval = 30000, managedSchedule = false }: SyncOptions) {
    Object.assign(this, { root, client, codexHome: client === 'claude' ? claudeHome : codexHome, binary, changed, interval, managedSchedule });
    this.file = path.join(root, 'sync.json'); this.cache = path.join(root, 'sync-cache');
    this.projectDirectory = path.resolve(root, '..', 'fluid-projects');
    this.entries = []; this.phase = 'idle'; this.error = ''; this.lastSynced = null;
    try { this.config = this.load(); }
    catch (error) { this.config = { selected: {}, projects: {} }; this.error = error.message; this.phase = 'error'; }
    this.outbound = null;
    this.fetch = fetchImpl || ((url, options) => { this.outbound ||= createUpstreamFetch(root); return this.outbound.fetch(url, options); });
    this.tasks = tasks || (client === 'claude' ? new ClaudeTasks({ claudeHome }) : new CodexTasks({ binary, codexHome, token: () => init(root).token }));
    this.localCache = null; this.localDirty = true;
    this.remoteCache = new Map();
    this.historyHashes = new Map();
    this.closed = true; this.paused = false;
  }
  load(): SyncConfig {
    try {
      const config = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid sync settings.');
      return { device: this.config?.device || randomUUID(), selected: {}, projects: {}, ...config,
        ...(this.client === 'claude' && { selected: config.claude?.selected || {}, projects: config.claude?.projects || {} }) };
    }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Unable to read task sync settings.'); return { device: randomUUID(), selected: {}, projects: {} }; }
  }
  save() {
    let previous: Partial<SyncConfig> = {};
    try { previous = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const { selected, projects, claude, ...connection } = this.config;
    const changedStorage = ['kind', 'url', 'username'].some(key => (previous[key] || '') !== (connection[key] || ''));
    if (changedStorage) { previous.selected = {}; previous.projects = {}; previous.claude = { selected: {}, projects: {} }; }
    atomic(this.file, this.client === 'claude' ? { ...previous, ...connection, selected: previous.selected || {}, projects: previous.projects || {}, claude: { selected, projects } }
      : { ...previous, ...connection, selected, projects });
  }
  async exclusive<T>(operation: () => T | Promise<T>, wait = 5000): Promise<T> {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const lock = path.join(this.root, 'sync.lock'), deadline = Date.now() + wait;
    let fd;
    while (fd === undefined) {
      try { fd = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const pid = Number(fs.readFileSync(lock, 'utf8'));
          if (Number.isInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); }
            catch (error) { if (error.code === 'ESRCH') { fs.rmSync(lock, { force: true }); continue; } }
          } else if (Date.now() - fs.statSync(lock).mtimeMs > 300000) { fs.rmSync(lock, { force: true }); continue; }
        } catch (error) { if (error.code === 'ENOENT') continue; }
        if (Date.now() >= deadline) throw Object.assign(new Error('Another task sync is in progress. Try again shortly.'), { code: 'SYNC_BUSY' });
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    try { this.config = this.load(); return await operation(); }
    finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
  }
  snapshot() {
    const { kind, url, username, enabled } = this.config;
    const configured = hasStorage(this.config);
    return { client: this.client, configured, kind: (kind === 'webdav' ? 'webdav' : 'ssh') as StorageKind, url: configured ? url : '', username: configured ? username || '' : '',
      legacyStorage: kind === 'server' && !!url, enabled: configured && !!enabled, hasPassphrase: !!this.config.passphrase,
      phase: this.phase, error: this.error,
      lastSynced: this.lastSynced, tasks: this.entries.map(task => ({ ...task, path: undefined })), projects: this.config.projects };
  }
  storage(config = this.config) {
    const namespace = this.client === 'claude' ? 'claude' : '';
    return config.kind === 'ssh' ? new SshSyncStorage(config.url, namespace) : new SyncStorage({ url: config.url + (namespace ? namespace + '/' : ''), username: config.username, secret: config.secret }, this.fetch);
  }
  async configure(input: SyncSetup) {
    if (this.pending) await this.pending;
    return this.exclusive(async () => {
      if (!storageKinds.includes(input.kind)) throw new Error('Choose a sync storage method.');
      const url = input.kind === 'ssh' ? sshDestination(input.url) : webdavLibraryURL(input.url, this.config.kind === 'webdav' ? this.config.url : undefined);
      const username = input.kind === 'webdav' ? String(input.username || '') : '';
      const sameStorage = input.kind === this.config.kind && url === this.config.url && username === (this.config.username || '');
      const next = { ...this.config, kind: input.kind, url, username,
        secret: input.kind === 'ssh' ? '' : input.secret || (sameStorage ? this.config.secret : ''),
        passphrase: input.passphrase || this.config.passphrase, enabled: input.enabled !== false };
      if (input.kind !== 'ssh' && (typeof next.secret !== 'string' || !next.secret)) throw new Error('Enter sync server credentials.');
      syncKey(next.passphrase);
      const storage = this.storage(next);
      if (this.client === 'claude' && next.kind === 'webdav') await new SyncStorage({ url: next.url, username: next.username, secret: next.secret }, this.fetch).initialize();
      await storage.initialize();
      // Check an existing library before saving a possibly incorrect passphrase.
      await new SyncJournal(storage, syncKey(next.passphrase)).read();
      if (!sameStorage) {
        next.selected = {}; next.projects = {};
        this.entries = this.entries.filter(task => task.local).map(task => ({ ...task, remote: false, cleanupPending: false, enabled: false, status: 'off', message: '' }));
        this.lastSynced = null;
      }
      this.remoteCache.clear(); this.remoteInitialized = false;
      await this.outbound?.close(); this.outbound = null;
      this.config = next; this.save(); this.error = ''; this.phase = 'idle'; this.changed(); this.stopWatching(); this.watch(); this.schedule(0);
      return this.snapshot();
    });
  }
  async refreshLocal(signal?: AbortSignal) {
    this.localDirty = false;
    try {
      this.localCache = await this.tasks.list(signal);
      this.metadataTime = Date.now();
      return this.localCache;
    } catch (error) { this.localDirty = true; throw error; }
  }
  async list() {
    const local = await this.refreshLocal();
    const localIds = new Set(local.map(task => task.id));
    const map = new Map(this.entries.filter(task => task.remote || task.cleanupPending || localIds.has(task.id)).map(task => [task.id, task]));
    for (const task of local) {
      const existing = map.get(task.id), selected = this.config.selected[task.id];
      map.set(task.id, { ...existing, ...task, local: true, enabled: !!selected?.enabled,
        ...(!existing?.remote && !existing?.cleanupPending && !selected?.enabled && selected?.generation && { status: 'removed' }) });
    }
    this.entries = [...map.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); this.changed();
    return this.snapshot();
  }
  async select({ id, enabled }: { id: string; enabled: boolean }) {
    if (this.pending) await this.pending;
    return this.exclusive(async () => {
      if (!syncID(id) || typeof enabled !== 'boolean') throw new Error('Select a task to synchronize.');
      if (!this.entries.some(task => task.id === id)) await this.list();
      const task = this.entries.find(task => task.id === id);
      if (!task) throw new Error('This task is not available.');
      this.config.selected[id] = { ...this.config.selected[id], enabled };
      Object.assign(task, { enabled, status: enabled ? 'pending' : task.remote ? 'paused' : task.status === 'removed' ? 'removed' : 'off', message: '' });
      this.save(); this.schedule(0); this.changed(); return this.snapshot();
    });
  }
  stopRemoved(id: string, generation: string) {
    this.config.selected[id] = { enabled: false, generation };
    this.historyHashes.delete(id);
    const entry = this.entries.find(task => task.id === id);
    if (entry?.local) Object.assign(entry, { enabled: false, remote: false, cleanupPending: false, status: 'removed', message: '' });
    else this.entries = this.entries.filter(task => task.id !== id);
  }
  async removeRemote({ id, storage }: { id: string; storage?: SyncConnection }) {
    if (this.pending) await this.pending;
    return this.exclusive(async () => {
      if (!syncID(id) || !hasStorage(this.config)) throw new Error('Select a task with a remote copy.');
      if (storage && ['kind', 'url', 'username'].some(key => (this.config[key] || '') !== storage[key]))
        throw new Error('Sync storage changed. Refresh the task list and try again.');
      const journal = new SyncJournal(this.storage(), syncKey(this.config.passphrase), this.remoteCache, path.join(this.cache, 'journal-' + this.client));
      const remote = await journal.read();
      const generation = journal.generation(id, this.config.selected[id]?.generation);
      if (remote.has(id)) await journal.markRemoved(id);
      else if (!generation) throw new Error('The remote task is no longer available.');
      const marked = journal.generation(id);
      this.config.selected[id] = { enabled: false, generation: marked }; this.save();
      const entry = this.entries.find(task => task.id === id);
      if (entry) Object.assign(entry, { enabled: false, remote: false, cleanupPending: true, status: 'removing', message: '' });
      try {
        await journal.read();
        const current = journal.generation(id, marked);
        await journal.prune(id);
        this.stopRemoved(id, current); this.save();
        this.error = ''; this.phase = 'idle';
      } catch (error) {
        this.error = error.message; this.phase = 'error';
        throw error;
      } finally { this.changed(); this.schedule(); }
      return this.snapshot();
    });
  }
  async mapProject({ key, directory }: { key: string; directory: string }) {
    if (this.pending) await this.pending;
    return this.exclusive(async () => {
      if (!/^[a-f0-9]{64}$/.test(key || '') || typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('Choose a local project folder.');
      this.config.projects[key] = path.resolve(directory); this.save(); this.schedule(0); return this.snapshot();
    });
  }
  async resolve({ id, choice }: { id: string; choice: string }) {
    if (this.pending) await this.pending;
    await this.exclusive(async () => {
      if (!hasStorage(this.config) || !syncID(id) || !['local', 'remote'].includes(choice) || !this.config.selected[id]?.enabled)
        throw new Error('Choose a version of this synchronized task.');
      const storage = this.storage(), key = syncKey(this.config.passphrase), journal = new SyncJournal(storage, key);
      const refs = await journal.read(), ref = refs.get(id);
      const generation = journal.generation(id, this.config.selected[id].generation);
      if (!ref || (this.config.selected[id].generation || '') !== generation) throw new Error('The remote task is no longer available.');
      const task = (await this.tasks.list()).find(task => task.id === id);
      if (!task) {
        if (choice !== 'remote') throw new Error('The local task is no longer available.');
        await journal.publish(ref, ref.heads); this.config.selected[id] = { enabled: true, generation }; this.save(); return;
      }
      const project = await projectSnapshot(task.cwd, this.cache, false), history = this.tasks.read(task, project.root);
      if (!history) throw new Error('Wait until this turn finishes before choosing a version.');
      fs.mkdirSync(this.cache, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(this.cache, 'conflict-' + id + '.bin'), seal(ref, key), { mode: 0o600 });
      if (choice === 'remote') await journal.publish(ref, ref.heads);
      this.config.selected[id] = { ...this.config.selected[id], revision: choice === 'local' ? ref.revision : digest(history.hash + project.fingerprint),
        historyHash: choice === 'remote' ? history.contentHash || history.hash : undefined, projectHash: project.fingerprint, resolution: choice === 'local' ? ref.heads : undefined };
      this.save();
    });
    return this.run();
  }
  start() { this.closed = false; this.watch(); this.schedule(0); }
  watch() {
    if (!hasStorage(this.config) || !this.config.enabled || !this.codexHome || this.paused || this.closed) return;
    this.sessionWatchers ??= new Map();
    for (const folder of this.client === 'claude' ? ['projects'] : ['sessions', 'archived_sessions']) {
      if (this.sessionWatchers.has(folder)) continue;
      const directory = path.join(this.codexHome, folder);
      if (!fs.existsSync(directory)) continue;
      try {
        const watcher = fs.watch(directory, { recursive: true, persistent: false }, () => { this.localDirty = true; });
        this.sessionWatchers.set(folder, watcher); this.localDirty = true;
        watcher.on('error', () => { watcher.close(); this.sessionWatchers.delete(folder); this.localDirty = true; });
      } catch { /* Metadata is periodically refreshed on filesystems without recursive watchers. */ }
    }
  }
  stopWatching() { for (const watcher of this.sessionWatchers?.values() || []) watcher.close(); this.sessionWatchers?.clear(); }
  setPaused(value: boolean) { this.paused = value; if (value) { clearTimeout(this.timer); this.abort?.abort(); this.stopWatching(); } else { this.watch(); this.schedule(0); } }
  schedule(ms = this.interval) {
    clearTimeout(this.timer);
    if (this.managedSchedule || this.closed || this.paused || !this.config.enabled || !hasStorage(this.config)) return;
    this.timer = setTimeout(() => this.run().catch(() => {}), ms); this.timer.unref?.();
  }
  async close() { this.closed = true; clearTimeout(this.timer); this.abort?.abort(); this.stopWatching(); await this.pending; await this.outbound?.close(); }
  run() {
    if (this.pending) return this.pending;
    const previous = this.config;
    try { this.config = this.load(); }
    catch (error) { this.error = error.message; this.phase = 'error'; this.schedule(300000); return Promise.resolve(this.snapshot()); }
    if (['url', 'kind', 'username', 'secret', 'passphrase'].some(key => previous[key] !== this.config[key])) { this.remoteCache.clear(); this.remoteInitialized = false; }
    if (!hasStorage(this.config) || !this.config.enabled || this.paused) return Promise.resolve(this.snapshot());
    clearTimeout(this.timer); this.abort = new AbortController();
    this.pending = this.exclusive(() => this.cycle(this.abort.signal), 0).catch(error => {
      if (!this.abort.signal.aborted) { this.error = error.message; this.phase = error.code === 'SYNC_BUSY' ? 'idle' : 'error'; }
      return this.snapshot();
    }).finally(() => { this.pending = null; this.changed(); this.schedule(this.error ? Math.min(this.interval * 5, 300000) : this.interval); });
    return this.pending;
  }
  async cycle(signal: AbortSignal) {
    this.phase = 'syncing'; this.error = ''; this.changed();
    const storage = this.storage(), key = syncKey(this.config.passphrase);
    if (this.client === 'claude' && !this.remoteInitialized) { await storage.initialize(signal); this.remoteInitialized = true; }
    const journal = new SyncJournal(storage, key, this.remoteCache, path.join(this.cache, 'journal-' + this.client)), remote = await journal.read(signal);
    let cleanupError;
    for (const [id, selected] of Object.entries(this.config.selected)) if (selected.generation) journal.generation(id, selected.generation);
    for (const id of journal.deletions.keys()) {
      const previous = this.config.selected[id], generation = journal.generation(id);
      if (previous ? (previous.generation || '') !== generation : !remote.has(id)) this.stopRemoved(id, generation);
    }
    for (const id of journal.retired.keys()) {
      try { await journal.prune(id, signal); }
      catch (error) { signal.throwIfAborted(); cleanupError ||= error; }
    }
    const published = new Set();
    for (const [id, ref] of remote) {
      let entry = this.entries.find(task => task.id === id);
      if (!entry) { entry = { id, local: false }; this.entries.push(entry); }
      Object.assign(entry, { title: ref.title, projectKey: ref.projectKey, remote: true, updatedAt: ref.updatedAt });
      if (!Object.hasOwn(this.config.selected, id)) this.config.selected[id] = { enabled: true, generation: journal.generation(id) };
      entry.enabled = this.config.selected[id].enabled;
    }
    this.watch();
    const needsLocal = remote.size || Object.values(this.config.selected).some(task => task.enabled);
    const local = needsLocal && (this.localDirty || !this.localCache || !this.sessionWatchers?.size || Date.now() - this.metadataTime >= 300000 ||
      this.localCache.some(task => this.config.selected[task.id]?.enabled && task.path && !fs.existsSync(task.path)))
      ? await this.refreshLocal(signal) : this.localCache || [];
    const localMap = new Map(local.map(task => [task.id, task]));
    // Recheck an existing import by ID if it moved between the active and archive listings.
    const missing = [...remote.keys()].filter(id => {
      const selected = this.config.selected[id];
      return selected?.enabled && (selected.revision || selected.installingHistoryHash) && !localMap.has(id);
    });
    if (missing.length && this.tasks.find) {
      for (const task of await this.tasks.find(missing, signal)) { localMap.set(task.id, task); this.localDirty = true; }
    }
    const projectStates = new Map<string, ProjectSnapshot>(), projectsByDirectory = new Map<string, ProjectSnapshot>();
    for (const task of localMap.values()) if (this.config.selected[task.id]?.enabled) {
      try {
        const snapshot = projectsByDirectory.get(task.cwd) || await projectSnapshot(task.cwd, this.cache, false);
        projectsByDirectory.set(task.cwd, snapshot); projectStates.set(task.id, snapshot);
      }
      catch { /* Per-task errors below retain their own status. */ }
    }
    const touchedProjects = new Set();
    const provider = this.tasks.routingProvider?.();
    for (const [id, selected] of Object.entries(this.config.selected)) {
      signal.throwIfAborted();
      const task = localMap.get(id), ref = remote.get(id);
      let entry = this.entries.find(task => task.id === id);
      if (entry && task) Object.assign(entry, task, { local: true });
      if (!selected.enabled && !task && !ref) continue;
      if (!entry) { entry = { ...task, id, enabled: true }; this.entries.push(entry); }
      Object.assign(entry, { enabled: selected.enabled, remote: !!ref });
      if (!selected.enabled) {
        Object.assign(entry, { status: ref ? 'paused' : selected.generation ? 'removed' : 'off', message: '' });
        continue;
      }
      entry.message = '';
      try {
        if (ref?.conflict && !selected.resolution) { entry.status = 'conflict'; continue; }
        let history: Omit<SessionHistory, 'records' | 'timestamp'> & Partial<Pick<SessionHistory, 'records' | 'timestamp'>>;
        let project: ProjectSnapshot, revision: string;
        if (task) {
          project = projectStates.get(id) || await projectSnapshot(task.cwd, this.cache, false);
          const stamp = this.tasks.stamp?.(task), cached = this.historyHashes.get(id);
          history = stamp && cached?.stamp === stamp && cached.root === project.root ? cached.history : this.tasks.read(task, project.root);
          if (!history) { entry.status = 'running'; continue; }
          const localHistoryHash = history.contentHash || history.hash;
          if (selected.installingHistoryHash === localHistoryHash ||
              selected.historyHash && [history.hash, history.legacyHash].includes(selected.historyHash)) {
            selected.historyHash = localHistoryHash;
          }
          const repairProvider = provider && (history.providerRepair || task.provider !== provider || selected.providerRepair);
          if (history.workspaceRepair || repairProvider) {
            if (repairProvider && !selected.providerRepair) {
              selected.providerRepair = true;
              this.save();
            }
            await this.tasks.repair(task, project.root, signal, { workspaceRepair: history.workspaceRepair, provider: repairProvider ? provider : undefined });
            if (repairProvider) {
              task.provider = provider;
              delete selected.providerRepair;
            }
            history = this.tasks.read(task, project.root); this.historyHashes.delete(id);
            if (!history) { entry.status = 'running'; continue; }
          } else if (stamp) {
            const { hash, contentHash, legacyHash, providerRepair } = history;
            this.historyHashes.set(id, { stamp, root: project.root, history: { hash, contentHash, legacyHash, providerRepair } });
          }
          entry.projectKey ||= Object.keys(this.config.projects).find(key => !path.relative(this.config.projects[key], project.root)) ||
            digest(this.config.device + ':' + project.root);
          this.config.projects[entry.projectKey] ||= project.root;
          if (touchedProjects.has(fs.realpathSync(project.root))) { entry.status = 'pending'; this.localDirty = true; continue; }
          revision = digest(history.hash + project.fingerprint);
          Object.assign(entry, task, { local: true });
        }
        const historyHash = history?.contentHash || history?.hash;
        if (ref && revision === ref.revision && !selected.resolution) {
          Object.assign(selected, { revision, historyHash, projectHash: project.fingerprint });
          delete selected.installingHistoryHash;
          entry.status = 'synced'; continue;
        }
        const localChanged = !!task && (selected.historyHash ? historyHash !== selected.historyHash || project.fingerprint !== selected.projectHash : revision !== selected.revision);
        const remoteChanged = !!ref && ref.revision !== selected.revision;
        if (ref && (!task || remoteChanged) && !selected.resolution) {
          entry.projectKey = ref.projectKey;
          const object = await storage.get(`objects/${ref.object}.bin`, signal);
          if (!object || digest(object.data) !== ref.object) throw new Error('The synchronized task package is incomplete.');
          const pack = unseal<{ version: number; id: string; history: SessionHistory; project: ProjectSnapshot; client?: Client }>(object.data, key);
          if (pack.version !== 1 || (pack.client || 'codex') !== this.client || pack.id !== id || !pack.history || !pack.project) throw new Error('Invalid synchronized task package.');
          const incomingHash = this.tasks.contentHash?.(pack.history.records, pack.history.sessionFiles) ?? pack.history.hash;
          if (localChanged && (
              (historyHash !== selected.historyHash && historyHash !== incomingHash) ||
              (project.fingerprint !== selected.projectHash && project.fingerprint !== pack.project.fingerprint))) {
            entry.status = 'conflict'; entry.message = 'Both computers changed this task. Local and remote versions are preserved.'; continue;
          }
          const mapped = this.config.projects[ref.projectKey];
          const directory = path.resolve(mapped || path.join(this.projectDirectory, ref.projectKey));
          const { relative } = pack.project;
          const cwd = relative === '' ? directory : inside(directory, relative);
          if (!mapped) {
            fs.mkdirSync(this.projectDirectory, { recursive: true, mode: 0o700 });
            if (!fs.lstatSync(this.projectDirectory).isDirectory()) throw new Error('The automatic sync project location must be a local directory.');
          }
          if (task && (this.tasks.read(task, project.root)?.hash !== history.hash)) { entry.status = 'running'; continue; }
          if (task && project.fingerprint !== (await projectSnapshot(task.cwd, this.cache, false)).fingerprint) throw new Error('The local project changed during sync. Retry after this turn finishes.');
          const projectPath = fs.existsSync(directory) ? fs.realpathSync(directory) : null;
          const shared = projectPath ? [...localMap.values()].filter(item => {
            if (item.id === id) return false;
            try {
              const relative = path.relative(projectPath, fs.realpathSync(item.cwd));
              return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
            } catch { return false; }
          }) : [];
          const previousProject = project || shared.map(item => projectStates.get(item.id)).find(Boolean);
          const apply = async (writerSignal = signal) => {
            writerSignal.throwIfAborted();
            if (task && this.tasks.read(task, project.root)?.hash !== history.hash) throw Object.assign(new Error('The local task changed during sync.'), { code: 'SYNC_BUSY' });
            await restoreProject(pack.project, directory, this.cache, selected.projectHash);
            touchedProjects.add(fs.realpathSync(directory));
            this.localDirty = true; this.historyHashes.delete(id);
            for (const other of shared) if (previousProject && this.config.selected[other.id]?.projectHash === previousProject.fingerprint &&
                projectStates.get(other.id)?.root === previousProject.root)
              this.config.selected[other.id].projectHash = pack.project.fingerprint;
            // Recognize our own completed writes if the rollout replacement or indexing must be retried.
            this.config.projects[ref.projectKey] = directory;
            selected.projectHash = pack.project.fingerprint;
            selected.installingHistoryHash = incomingHash;
            if (provider) selected.providerRepair = true;
            this.save();
            writerSignal.throwIfAborted();
            fs.mkdirSync(relative ? inside(directory, relative) : cwd, { recursive: true });
            if (!fs.lstatSync(cwd).isDirectory()) throw new Error('The synchronized working directory must be a local directory.');
            return this.tasks.install({ id, title: ref.title, provider: provider || task?.provider, archived: task?.archived },
              pack.history, cwd, task?.path, writerSignal, directory);
          };
          const writers = [task || { id }, ...(pack.project.fingerprint !== previousProject?.fingerprint ? shared : [])];
          const installed = this.tasks.withWriter ? await this.tasks.withWriter(writers, signal, apply) : await apply();
          Object.assign(selected, { revision: ref.revision, historyHash: incomingHash });
          delete selected.installingHistoryHash;
          if (provider) delete selected.providerRepair;
          Object.assign(entry, { local: true, path: installed, cwd, archived: !!task?.archived, provider: provider || task?.provider, status: 'synced', message: '' });
        } else if (task && (localChanged || selected.resolution)) {
          if (!history.records) history = this.tasks.read(task, project.root);
          if (!history) { entry.status = 'running'; continue; }
          if (project.kind !== 'folder') project.bundle = fs.readFileSync(path.join(this.cache, project.head + '.bundle')).toString('base64');
          const pack = { version: 1, client: this.client, id, title: task.title, history, project };
          const bytes = seal(pack, key), object = digest(bytes);
          const next = { id, title: task.title, projectKey: entry.projectKey, revision, object, updatedAt: Date.now(), device: this.config.device };
          const latest = (await journal.read(signal)).get(id);
          const generation = journal.generation(id, selected.generation);
          if ((selected.generation || '') !== generation) {
            remote.delete(id);
            this.stopRemoved(id, generation); this.save();
            continue;
          }
          const heads = selected.resolution || ref?.heads || [];
          if (JSON.stringify(latest?.heads || []) !== JSON.stringify(heads)) throw Object.assign(new Error('Another computer published a revision. Both versions are preserved.'), { code: 'SYNC_CONFLICT' });
          // Tie the upload to the observed deletion records. A concurrent removal can then reclaim it.
          await storage.putImmutable(`objects/${object}.bin`, bytes, signal);
          await journal.publish(next, heads, signal, generation);
          published.add(id);
          Object.assign(selected, { revision, historyHash, projectHash: project.fingerprint, resolution: undefined });
          entry.status = 'synced'; entry.remote = true; entry.message = '';
        } else entry.status = 'synced';
      } catch (error) {
        const moved = error.code === 'ENOENT' && task?.path && !fs.existsSync(task.path);
        if (moved || error.code === 'SYNC_FILE_BUSY') this.localDirty = true;
        entry.status = moved ? 'waitingFile' : { SYNC_CONFLICT: 'conflict', SYNC_BUSY: 'opened', SYNC_FILE_BUSY: 'waitingFile' }[error.code] || 'error';
        entry.message = moved ? 'The Codex task moved during sync. Its location will be refreshed.' : error.message;
      }
      this.save();
    }
    for (const entry of this.entries) {
      entry.remote = remote.has(entry.id) || published.has(entry.id);
      entry.cleanupPending = journal.retired.has(entry.id);
      if (!entry.enabled && !entry.remote && entry.cleanupPending) entry.status = 'removing';
    }
    this.entries = this.entries.filter(entry => entry.local || entry.remote || entry.cleanupPending);
    this.save(); this.phase = cleanupError ? 'error' : 'idle'; this.error = cleanupError?.message || '';
    this.lastSynced = Date.now(); this.changed(); return this.snapshot();
  }
}

// Both clients share one connection and retain independent local selections and journals.
export class SessionSync {
  readonly clients: Record<Client, TaskSync>;
  client: Client = 'codex';
  timer?: NodeJS.Timeout;
  running?: Promise<ReturnType<TaskSync['snapshot']>>;
  closing = false;
  readonly interval: number;
  readonly managedSchedule: boolean;
  constructor(options: SyncOptions) {
    this.interval = options.interval || 30000; this.managedSchedule = !!options.managedSchedule;
    this.clients = { codex: new TaskSync({ ...options, managedSchedule: true }), claude: new TaskSync({ ...options, managedSchedule: true, tasks: undefined, client: 'claude' }) };
  }
  get active() { return this.clients[this.client]; }
  get pending() { return this.running || Promise.all(Object.values(this.clients).map(sync => sync.pending)); }
  get closed() { return this.clients.codex.closed; }
  set closed(value: boolean) { for (const sync of Object.values(this.clients)) sync.closed = value; }
  snapshot() { return this.active.snapshot(); }
  async setClient(client: Client) {
    if (!['codex', 'claude'].includes(client)) throw new Error('Choose Codex or Claude Code.');
    await this.pending; this.client = client; this.active.config = this.active.load(); return this.active.list();
  }
  list() { this.active.config = this.active.load(); return this.active.list(); }
  async configure(input: SyncSetup) {
    await this.pending; await this.active.configure(input);
    for (const sync of Object.values(this.clients)) { sync.config = sync.load(); sync.remoteCache.clear(); sync.remoteInitialized = false; }
    this.schedule(0); return this.snapshot();
  }
  select(input: Parameters<TaskSync['select']>[0]) { return this.active.select(input); }
  removeRemote(input: Parameters<TaskSync['removeRemote']>[0]) { return this.active.removeRemote(input); }
  resolve(input: Parameters<TaskSync['resolve']>[0]) { return this.active.resolve(input); }
  run() {
    if (this.running) return this.running;
    this.running = (async () => {
      for (const client of [this.client, this.client === 'codex' ? 'claude' : 'codex'] as const) { if (this.closing) break; await this.clients[client].run(); }
      return this.snapshot();
    })().finally(() => {
      this.running = undefined; this.schedule(Object.values(this.clients).some(sync => sync.error) ? this.interval * 5 : this.interval);
    });
    return this.running;
  }
  schedule(ms = this.interval) {
    clearTimeout(this.timer);
    if (this.managedSchedule || this.closed || this.clients.codex.paused) return;
    const config = this.active.load();
    if (!config.enabled || !hasStorage(config)) return;
    this.timer = setTimeout(() => this.run().catch(() => {}), ms); this.timer.unref?.();
  }
  start() { this.closing = false; for (const sync of Object.values(this.clients)) sync.start(); this.schedule(0); }
  setPaused(value: boolean) { for (const sync of Object.values(this.clients)) sync.setPaused(value); clearTimeout(this.timer); if (!value) this.schedule(0); }
  async close() { this.closing = true; clearTimeout(this.timer); await Promise.all(Object.values(this.clients).map(sync => sync.close())); await this.running; }
}
