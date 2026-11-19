import { digest, seal, unseal, syncID } from './sync-storage.js';

const hash = value => /^[a-f0-9]{64}$/.test(value || '');
export class SyncJournal {
  constructor(storage, key, cache = new Map()) { Object.assign(this, { storage, key, cache }); }
  async read(signal) {
    const nodes = new Map(), groups = new Map();
    const references = await this.storage.references(signal), seen = new Set(references.map(item => item.id));
    for (const name of this.cache.keys()) if (!seen.has(name)) this.cache.delete(name);
    for (const { id: name, etag } of references) {
      const cached = this.cache.get(name);
      let node;
      if ((cached?.version === 2 && !etag) || (etag && cached?.etag === etag)) node = cached;
      else {
        const item = await this.storage.get(`refs/${name}.bin`, signal, cached?.etag);
        if (!item) throw new Error('The task revision journal is incomplete. Retry when storage has finished syncing.');
        node = item.unchanged ? cached : { ...unseal(item.data, this.key), node: digest(item.data), etag: item.etag, name };
        this.cache.set(name, node);
      }
      if (![1, 2].includes(node.version) || !syncID(node.id) || !hash(node.revision) || !hash(node.object) || !hash(node.projectKey) ||
          node.version === 2 && (node.node !== name || !Array.isArray(node.parents) || node.parents.length > 100 || node.parents.some(parent => !hash(parent))))
        throw new Error('Unsupported remote task sync format.');
      if (node.version === 1 && node.id !== name) throw new Error('Invalid legacy task revision.');
      nodes.set(node.node, node);
      if (!groups.has(node.id)) groups.set(node.id, []);
      groups.get(node.id).push(node);
    }
    const result = new Map();
    for (const [id, history] of groups) {
      const parents = new Set(history.flatMap(node => node.parents || []));
      if (history.some(node => (node.parents || []).some(parent => nodes.get(parent)?.id !== id))) throw new Error('The task revision journal is incomplete. Retry when storage has finished syncing.');
      const heads = history.filter(node => !parents.has(node.node)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.node.localeCompare(b.node));
      if (!heads.length) throw new Error('Invalid task revision journal.');
      result.set(id, { ...heads[0], heads: heads.map(node => node.node).sort(), conflict: new Set(heads.map(node => node.revision)).size > 1 });
    }
    return result;
  }
  async publish(ref, heads = [], signal) {
    const { id, title, projectKey, revision, object, updatedAt, device } = ref;
    const value = { version: 2, id, title, projectKey, revision, object, updatedAt, device, parents: [...new Set(heads)].sort() };
    const bytes = seal(value, this.key), node = digest(bytes);
    await this.storage.putImmutable(`refs/${node}.bin`, bytes, signal);
    return { ...value, node, heads: [node], conflict: false };
  }
}
