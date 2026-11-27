import fs from 'node:fs';
import path from 'node:path';
import { digest, seal, unseal, syncID, type RevisionStorage } from './sync-storage.js';

const hash = value => /^[a-f0-9]{64}$/.test(value || '');
const incomplete = () => new Error('The task revision journal is incomplete. Retry when storage has finished syncing.');
export interface Revision {
  id: string; title: string; projectKey: string; revision: string; object: string; updatedAt: number; device: string;
}
interface JournalNode extends Revision {
  version: number; node: string; etag: string | null; name: string; parents?: string[]; deletions?: string[];
}
export interface JournalHead extends JournalNode { heads: string[]; conflict: boolean; }
export type JournalCache = Map<string, JournalNode>;

export class SyncJournal {
  declare storage: RevisionStorage;
  declare key: Buffer;
  declare cache: JournalCache;
  declare deletions: Map<string, Set<string>>;
  declare retired: Map<string, JournalNode[]>;
  declare liveObjects: Set<string>;

  constructor(storage: RevisionStorage, key: Buffer, cache: JournalCache = new Map(), readonly directory?: string) { Object.assign(this, { storage, key, cache, deletions: new Map() }); }
  async read(signal?: AbortSignal) {
    const nodes = new Map<string, JournalNode>();
    const groups = new Map<string, JournalNode[]>();
    const deletions = new Map<string, Set<string>>();
    const retired = new Map<string, JournalNode[]>();
    const liveObjects = new Set<string>();
    const references = (await this.storage.references(signal)).map(ref => ({
      ...ref, name: ref.id + (ref.deleted ? '.deleted' : '.bin'),
    }));
    const seen = new Set(references.map(item => item.name));
    for (const name of this.cache.keys()) if (!seen.has(name)) this.cache.delete(name);
    const loaded = new Map<string, JournalNode>();
    let cursor = 0;
    const load = async () => {
      while (cursor < references.length) {
        signal?.throwIfAborted();
        const { id, name, etag, deleted } = references[cursor++], cached = this.cache.get(name);
        const immutable = hash(id);
        let node = cached && (immutable && cached.node === id || etag && cached.etag === etag) ? cached : undefined;
        let bytes: Buffer;
        if (!node && immutable && this.directory) {
          try { const saved = fs.readFileSync(path.join(this.directory, name)); if (digest(saved) === id) bytes = saved; } catch { /* A missing or damaged cache falls back to storage. */ }
        }
        if (!node) {
          if (!bytes) {
            const item = await this.storage.get(`refs/${name}`, signal, cached?.etag);
            if (!item) throw incomplete();
            if (item.unchanged) node = cached;
            else { bytes = item.data; node = { ...unseal<JournalNode>(bytes, this.key), node: digest(bytes), etag: item.etag, name }; }
          } else node = { ...unseal<JournalNode>(bytes, this.key), node: id, etag, name };
          if (!node) throw incomplete();
          if (immutable && (deleted || node.version === 2) && node.node !== id) throw new Error('The task revision failed its integrity check.');
          if (immutable && node.node === id && bytes && this.directory) {
            try { fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(this.directory, name), bytes, { mode: 0o600 }); } catch { /* Local cache availability must not prevent syncing. */ }
          }
        }
        loaded.set(name, node);
      }
    };
    // Small bounded batches reduce latency without flooding rate-limited WebDAV services.
    const results = await Promise.allSettled(Array.from({ length: Math.min(3, references.length) }, load));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    for (const { id, name, deleted } of references) {
      const node = loaded.get(name);
      this.cache.set(name, node);
      if (deleted) {
        if (node.version !== 1 || node.node !== id || !syncID(node.id)) throw new Error('Invalid remote task deletion.');
        if (!deletions.has(node.id)) deletions.set(node.id, new Set());
        deletions.get(node.id).add(id);
        continue;
      }
      if (![1, 2].includes(node.version) || !syncID(node.id) || !hash(node.revision) || !hash(node.object) || !hash(node.projectKey) ||
          node.version === 2 && (node.node !== id || !Array.isArray(node.parents) || node.parents.length > 100 || node.parents.some(parent => !hash(parent))) ||
          node.deletions !== undefined && (!Array.isArray(node.deletions) || node.deletions.some(marker => !hash(marker))))
        throw new Error('Unsupported remote task sync format.');
      if (node.version === 1 && node.id !== id) throw new Error('Invalid legacy task revision.');
      nodes.set(node.node, node);
      if (!groups.has(node.id)) groups.set(node.id, []);
      groups.get(node.id).push(node);
    }
    const result = new Map<string, JournalHead>();
    for (const [id, versions] of groups) {
      const markers = deletions.get(id);
      const history = versions.filter(node => {
        const seen = new Set(node.deletions);
        // A partially replicated listing must never cause a newer version to be removed.
        if ([...seen].some(marker => !markers?.has(marker))) throw incomplete();
        if (seen.size === (markers?.size || 0)) { liveObjects.add(node.object); return true; }
        if (!retired.has(id)) retired.set(id, []);
        retired.get(id).push(node);
        nodes.delete(node.node);
        return false;
      });
      groups.set(id, history);
    }
    for (const [id, history] of groups) {
      if (!history.length) continue;
      const parents = new Set(history.flatMap(node => node.parents || []));
      if (history.some(node => (node.parents || []).some(parent => nodes.get(parent)?.id !== id))) throw incomplete();
      const heads = history.filter(node => !parents.has(node.node)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.node.localeCompare(b.node));
      if (!heads.length) throw new Error('Invalid task revision journal.');
      result.set(id, { ...heads[0], heads: heads.map(node => node.node).sort(), conflict: new Set(heads.map(node => node.revision)).size > 1 });
    }
    if (this.directory) try {
      for (const name of fs.readdirSync(this.directory)) if (/^[a-f0-9]{64}\.(?:bin|deleted)$/.test(name) && !seen.has(name)) fs.rmSync(path.join(this.directory, name), { force: true });
    } catch { /* Cache cleanup is optional. */ }
    Object.assign(this, { deletions, retired, liveObjects });
    return result;
  }
  generation(id: string, known = '') {
    const markers = this.deletions.get(id);
    if (known && known.split(',').some(marker => !markers?.has(marker))) throw incomplete();
    return [...(markers || [])].sort().join(',');
  }
  async markRemoved(id: string, signal?: AbortSignal) {
    const bytes = seal({ version: 1, id }, this.key), hash = digest(bytes);
    await this.storage.putImmutable(`refs/${hash}.deleted`, bytes, signal);
    this.deletions.set(id, new Set([...(this.deletions.get(id) || []), hash]));
  }
  async prune(id: string, signal?: AbortSignal) {
    const versions = this.retired.get(id) || [];
    // Keep the old references until their packages are deleted so interrupted cleanup can resume.
    const objects = new Set(versions.map(node => node.object).filter(object => !this.liveObjects.has(object)));
    await this.storage.removeFiles([...objects].map(object => `objects/${object}.bin`), signal);
    await this.storage.removeFiles(versions.map(node => `refs/${node.name}`), signal);
    this.retired.delete(id);
  }
  async publish(ref: Revision, heads: string[] = [], signal?: AbortSignal, deletions = this.generation(ref.id)) {
    const { id, title, projectKey, revision, object, updatedAt, device } = ref;
    const value = { version: 2, id, title, projectKey, revision, object, updatedAt, device, parents: [...new Set(heads)].sort(),
      ...(deletions && { deletions: deletions.split(',') }) };
    const bytes = seal(value, this.key), node = digest(bytes);
    await this.storage.putImmutable(`refs/${node}.bin`, bytes, signal);
    return { ...value, node, heads: [node], conflict: false };
  }
}
