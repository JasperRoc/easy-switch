import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomic, init } from './store.js';
import { createUpstreamFetch } from './network.js';
import { SyncStorage, syncKey, syncURL, syncID, seal, unseal, digest } from './sync-storage.js';
import { CodexTasks } from './sync-codex.js';
import { inside, projectSnapshot, restoreProject } from './sync-project.js';
import { SyncJournal } from './sync-journal.js';

export class TaskSync {
  constructor({ root, codexHome, binary, fetchImpl, tasks, changed = () => {}, interval = 30000 }) {
    Object.assign(this, { root, codexHome, binary, changed, interval });
    this.file = path.join(root, 'sync.json'); this.cache = path.join(root, 'sync-cache');
    this.projectDirectory = path.resolve(root, '..', 'easy-switch-projects');
    this.entries = []; this.phase = 'idle'; this.error = ''; this.lastSynced = null;
    try { this.config = this.load(); }
    catch (error) { this.config = { selected: {}, projects: {} }; this.error = error.message; this.phase = 'error'; }
    this.outbound = null;
    this.fetch = fetchImpl || ((url, options) => { this.outbound ||= createUpstreamFetch(root); return this.outbound.fetch(url, options); });
    this.tasks = tasks || new CodexTasks({ binary, codexHome, token: () => init(root).token });
    this.localCache = null; this.localDirty = true;
    this.remoteCache = new Map();
    this.historyHashes = new Map();
    this.closed = true; this.paused = false;
  }
  load() {
    try {
      const config = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid sync settings.');
      return { device: this.config?.device || randomUUID(), selected: {}, projects: {}, ...config };
    }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Unable to read task sync settings.'); return { device: randomUUID(), selected: {}, projects: {} }; }
  }
  save() { atomic(this.file, this.config); }
  async exclusive(operation, wait = 5000) {
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
    return { configured: !!url, kind: kind || 'webdav', url: url || '', username: username || '', enabled: !!enabled,
      hasSecret: !!this.config.secret, hasPassphrase: !!this.config.passphrase, phase: this.phase, error: this.error,
      lastSynced: this.lastSynced, tasks: this.entries.map(task => ({ ...task, path: undefined })), projects: this.config.projects };
  }
  async configure(input) {
    if (this.pending) await this.pending;
    return this.exclusive(async () => {
      const next = { ...this.config, kind: input.kind, url: syncURL(input.url), username: String(input.username || ''),
        secret: input.secret || this.config.secret, passphrase: input.passphrase || this.config.passphrase, enabled: input.enabled !== false };
      if (!['webdav', 'server'].includes(next.kind) || typeof next.secret !== 'string' || !next.secret) throw new Error('Enter sync server credentials.');
      syncKey(next.passphrase);
      const storage = new SyncStorage(next, this.fetch); await storage.initialize();
      // Check an existing library before saving a possibly incorrect passphrase.
      await new SyncJournal(storage, syncKey(next.passphrase)).read();
      if (next.url !== this.config.url || next.kind !== this.config.kind) { next.selected = {}; this.entries = this.entries.filter(task => task.local).map(task => ({ ...task, remote: false, enabled: false, status: 'off', message: '' })); }
      this.remoteCache.clear();
      await this.outbound?.close(); this.outbound = null;
      this.config = next; this.save(); this.error = ''; this.changed(); this.stopWatching(); this.watch(); this.schedule(0);
      return this.snapshot();
    });
  }
  async list() {
    const local = await this.tasks.list();
    this.localCache = local; this.localDirty = false;
    const map = new Map(this.entries.filter(task => task.remote || local.some(item => item.id === task.id)).map(task => [task.id, task]));
    for (const task of local) map.set(task.id, { ...map.get(task.id), ...task, local: true, enabled: !!this.config.selected[task.id]?.enabled });
    this.entries = [...map.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); this.changed();
    return this.snapshot();
  }
  async select({ id, enabled }) {
    if (this.pending) await this.pending;
    return this.exclusive(async () => {
      if (!syncID(id) || typeof enabled !== 'boolean') throw new Error('Select a task to synchronize.');
      if (!this.entries.some(task => task.id === id)) await this.list();
      const task = this.entries.find(task => task.id === id);
      if (!task) throw new Error('This task is not available.');
      this.config.selected[id] = { ...this.config.selected[id], enabled };
      task.enabled = enabled; this.save(); this.schedule(0); this.changed(); return this.snapshot();
    });
  }
  async mapProject({ key, directory }) {
    if (this.pending) await this.pending;
    return this.exclusive(async () => {
      if (!/^[a-f0-9]{64}$/.test(key || '') || typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('Choose a local project folder.');
      this.config.projects[key] = path.resolve(directory); this.save(); this.schedule(0); return this.snapshot();
    });
  }
  async resolve({ id, choice }) {
    if (this.pending) await this.pending;
    await this.exclusive(async () => {
      if (!syncID(id) || !['local', 'remote'].includes(choice) || !this.config.selected[id]?.enabled) throw new Error('Choose a version of this synchronized task.');
      const storage = new SyncStorage(this.config, this.fetch), key = syncKey(this.config.passphrase), journal = new SyncJournal(storage, key);
      const refs = await journal.read(), ref = refs.get(id);
      if (!ref) throw new Error('The remote task is no longer available.');
      const task = (await this.tasks.list()).find(task => task.id === id);
      if (!task) {
        if (choice !== 'remote') throw new Error('The local task is no longer available.');
        await journal.publish(ref, ref.heads); this.config.selected[id] = { enabled: true }; this.save(); return;
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
    if (!this.config.enabled || !this.codexHome || this.sessionWatcher || this.paused || this.closed) return;
    const directory = path.join(this.codexHome, 'sessions'); if (!fs.existsSync(directory)) return;
    try {
      this.sessionWatcher = fs.watch(directory, { recursive: true, persistent: false }, () => { this.localDirty = true; });
      this.sessionWatcher.on('error', () => { this.sessionWatcher?.close(); this.sessionWatcher = null; this.localDirty = true; });
    } catch { /* The next visible task refresh still works on filesystems without recursive watchers. */ }
  }
  stopWatching() { this.sessionWatcher?.close(); this.sessionWatcher = null; }
  setPaused(value) { this.paused = value; if (value) { clearTimeout(this.timer); this.abort?.abort(); this.stopWatching(); } else { this.watch(); this.schedule(0); } }
  schedule(ms = this.interval) {
    clearTimeout(this.timer);
    if (this.closed || this.paused || !this.config.enabled || !this.config.url) return;
    this.timer = setTimeout(() => this.run().catch(() => {}), ms); this.timer.unref?.();
  }
  async close() { this.closed = true; clearTimeout(this.timer); this.abort?.abort(); this.stopWatching(); await this.pending; await this.outbound?.close(); }
  run() {
    if (this.pending) return this.pending;
    const previous = this.config;
    try { this.config = this.load(); }
    catch (error) { this.error = error.message; this.phase = 'error'; this.schedule(300000); return Promise.resolve(this.snapshot()); }
    if (['url', 'kind', 'secret', 'passphrase'].some(key => previous[key] !== this.config[key])) this.remoteCache.clear();
    if (!this.config.enabled || !this.config.url || this.paused) return Promise.resolve(this.snapshot());
    clearTimeout(this.timer); this.abort = new AbortController();
    this.pending = this.exclusive(() => this.cycle(this.abort.signal), 0).catch(error => {
      if (!this.abort.signal.aborted) { this.error = error.message; this.phase = error.code === 'SYNC_BUSY' ? 'idle' : 'error'; }
      return this.snapshot();
    }).finally(() => { this.pending = null; this.changed(); this.schedule(this.error ? Math.min(this.interval * 5, 300000) : this.interval); });
    return this.pending;
  }
  async cycle(signal) {
    this.phase = 'syncing'; this.error = ''; this.changed();
    const storage = new SyncStorage(this.config, this.fetch), key = syncKey(this.config.passphrase);
    const journal = new SyncJournal(storage, key, this.remoteCache), remote = await journal.read(signal);
    for (const [id, ref] of remote) {
      let entry = this.entries.find(task => task.id === id);
      if (!entry) { entry = { id, local: false }; this.entries.push(entry); }
      Object.assign(entry, { title: ref.title, projectKey: ref.projectKey, remote: true, updatedAt: ref.updatedAt });
      if (!Object.hasOwn(this.config.selected, id)) this.config.selected[id] = { enabled: true };
      entry.enabled = this.config.selected[id].enabled;
    }
    this.watch();
    const local = this.localDirty || !this.localCache || !this.sessionWatcher || Date.now() - (this.metadataTime || 0) >= 300000 ? await this.tasks.list(signal) : this.localCache;
    if (local !== this.localCache) this.metadataTime = Date.now();
    this.localCache = local; this.localDirty = false;
    const localMap = new Map(local.map(task => [task.id, task]));
    const projectStates = new Map(), projectsByDirectory = new Map();
    for (const task of local) if (this.config.selected[task.id]?.enabled) {
      try {
        const snapshot = projectsByDirectory.get(task.cwd) || await projectSnapshot(task.cwd, this.cache, false);
        projectsByDirectory.set(task.cwd, snapshot); projectStates.set(task.id, snapshot);
      }
      catch { /* Per-task errors below retain their own status. */ }
    }
    const touchedProjects = new Set();
    const provider = this.tasks.routingProvider?.();
    for (const [id, selected] of Object.entries(this.config.selected)) {
      signal.throwIfAborted(); if (!selected.enabled) continue;
      const task = localMap.get(id), ref = remote.get(id);
      let entry = this.entries.find(task => task.id === id);
      if (!entry) { entry = { ...task, id, enabled: true }; this.entries.push(entry); }
      entry.message = '';
      try {
        if (ref?.conflict && !selected.resolution) { entry.status = 'conflict'; continue; }
        let history, project, revision;
        if (task) {
          project = projectStates.get(id) || await projectSnapshot(task.cwd, this.cache, false);
          const stamp = this.tasks.stamp?.(task), cached = this.historyHashes.get(id);
          history = stamp && cached?.stamp === stamp ? cached.history : this.tasks.read(task, project.root);
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
            this.historyHashes.set(id, { stamp, history: { hash, contentHash, legacyHash, providerRepair } });
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
          const pack = unseal(object.data, key);
          if (pack.version !== 1 || pack.id !== id || !pack.history || !pack.project) throw new Error('Invalid synchronized task package.');
          const incomingHash = this.tasks.contentHash?.(pack.history.records) ?? pack.history.hash;
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
          const shared = projectPath ? local.filter(item => {
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
            return this.tasks.install({ id, title: ref.title, provider: provider || task?.provider }, pack.history, cwd, task?.path, writerSignal, directory);
          };
          const writers = [task || { id }, ...(pack.project.fingerprint !== previousProject?.fingerprint ? shared : [])];
          const installed = this.tasks.withWriter ? await this.tasks.withWriter(writers, signal, apply) : await apply();
          Object.assign(selected, { revision: ref.revision, historyHash: incomingHash });
          delete selected.installingHistoryHash;
          if (provider) delete selected.providerRepair;
          Object.assign(entry, { local: true, path: installed, cwd, provider: provider || task?.provider, status: 'synced', message: '' });
        } else if (task && (localChanged || selected.resolution)) {
          if (!history.records) history = this.tasks.read(task, project.root);
          if (!history) { entry.status = 'running'; continue; }
          if (project.kind !== 'folder') project.bundle = fs.readFileSync(path.join(this.cache, project.head + '.bundle')).toString('base64');
          const pack = { version: 1, id, title: task.title, history, project };
          const bytes = seal(pack, key), object = digest(bytes);
          await storage.putImmutable(`objects/${object}.bin`, bytes, signal);
          const next = { id, title: task.title, projectKey: entry.projectKey, revision, object, updatedAt: Date.now(), device: this.config.device };
          const latest = (await journal.read(signal)).get(id);
          const heads = selected.resolution || ref?.heads || [];
          if (JSON.stringify(latest?.heads || []) !== JSON.stringify(heads)) throw Object.assign(new Error('Another computer published a revision. Both versions are preserved.'), { code: 'SYNC_CONFLICT' });
          await journal.publish(next, heads, signal);
          Object.assign(selected, { revision, historyHash, projectHash: project.fingerprint, resolution: undefined });
          entry.status = 'synced'; entry.remote = true; entry.message = '';
        } else entry.status = 'synced';
      } catch (error) {
        entry.status = { SYNC_CONFLICT: 'conflict', SYNC_BUSY: 'opened', SYNC_FILE_BUSY: 'waitingFile' }[error.code] || 'error';
        entry.message = error.message;
      }
      this.save();
    }
    this.save(); this.phase = 'idle'; this.lastSynced = Date.now(); this.changed(); return this.snapshot();
  }
}
