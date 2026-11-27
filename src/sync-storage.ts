import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { syncURL } from './sync-url.js';
import type { ReadableStream } from 'node:stream/web';
import type { UpstreamFetch } from './network.js';

export interface StorageConfig { url: string; username?: string; secret?: string; }
export interface StorageReference { id: string; etag: string | null; deleted?: boolean; }
export interface StorageObject { data?: Buffer; etag: string | null; unchanged?: boolean; }
export interface RevisionStorage {
  references(signal?: AbortSignal): Promise<StorageReference[]>;
  get(name: string, signal?: AbortSignal, etag?: string): Promise<StorageObject | null>;
  putImmutable(name: string, data: Buffer, signal?: AbortSignal): Promise<void>;
  removeFiles(names: string[], signal?: AbortSignal): Promise<void>;
}

export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const syncID = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
export const maxPackage = 256 * 1024 * 1024;
export const syncFile = /^(?:refs\/[a-f0-9]{64}\.deleted|(?:refs|objects)\/[a-zA-Z0-9_-]{1,80}\.bin)$/;
export function syncReference(filename = '', etag: string | null = null): StorageReference | undefined {
  const deletion = /^([a-f0-9]{64})\.deleted$/.exec(filename);
  if (deletion) return { id: deletion[1], etag, deleted: true };
  const id = filename.endsWith('.bin') && filename.slice(0, -4);
  if (syncID(id) && !id.startsWith('probe_')) return { id, etag };
}
export function checkImmutable(name: string, data: Buffer) {
  if (data.length > maxPackage) throw new Error('Sync data exceeds 256 MiB.');
  if (/^refs\/probe_[a-f0-9]+\.bin$/.test(name)) return;
  if (!/^(?:refs\/[a-f0-9]{64}\.deleted|(?:refs|objects)\/[a-f0-9]{64}\.bin)$/.test(name))
    throw new Error('Immutable sync files require a content hash.');
  if (name.split('/')[1].split('.')[0] !== digest(data)) throw new Error('The sync filename does not match its content.');
}
// Protocol v1 salt is fixed binary data; changing it would invalidate encrypted libraries.
const formatSalt = Buffer.from([101, 97, 115, 121, 45, 115, 119, 105, 116, 99, 104, 47, 116, 97, 115, 107, 45, 115, 121, 110, 99, 47, 118, 49]);
const keys = new Map<string, Buffer>();
export function syncKey(password: string) {
  if (typeof password !== 'string' || password.length < 12) throw new Error('Use a sync passphrase of at least 12 characters.');
  const id = digest(password);
  if (!keys.has(id)) { if (keys.size >= 4) keys.delete(keys.keys().next().value); keys.set(id, scryptSync(password, formatSalt, 32)); }
  return keys.get(id);
}
export function seal(value: unknown, key: Buffer) {
  const plaintext = JSON.stringify(value);
  if (Buffer.byteLength(plaintext) > maxPackage - 32) throw new Error('Sync data exceeds 256 MiB.');
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from('ESS1'), nonce, cipher.getAuthTag(), encrypted]);
}
export function unseal<T>(data: Buffer, key: Buffer): T {
  if (data.length < 32 || data.subarray(0, 4).toString() !== 'ESS1') throw new Error('Invalid encrypted sync data.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(4, 16));
    decipher.setAuthTag(data.subarray(16, 32));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(32)), decipher.final()]).toString());
  } catch { throw new Error('Unable to decrypt sync data. Check the shared sync passphrase.'); }
}
export class SyncStorage implements RevisionStorage {
  readonly url: string;
  readonly fetch: UpstreamFetch;
  readonly config: StorageConfig;

  constructor(config: StorageConfig, fetchImpl: UpstreamFetch = fetch) { this.config = config; this.fetch = fetchImpl; this.url = syncURL(config.url); }
  async request(method: string, name = '', body?: RequestInit['body'] | Buffer, headers: Record<string, string> = {}, signal?: AbortSignal) {
    if (name && name !== 'refs/' && name !== 'objects/' && !syncFile.test(name)) throw new Error('Invalid sync object path.');
    const authentication = `Basic ${Buffer.from(`${this.config.username || ''}:${this.config.secret || ''}`).toString('base64')}`;
    let response;
    try {
      response = await this.fetch(this.url + name, { method, body: body as RequestInit['body'], headers: { authorization: authentication, 'user-agent': 'fluid/1 WebDAV', ...headers },
        redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error('Unable to reach the sync server. Check its address, credentials and connection.');
    }
    if (response.status === 412) { await response.body?.cancel(); throw Object.assign(new Error('The remote task changed during sync. Both versions have been preserved.'), { code: 'SYNC_CONFLICT' }); }
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok && !(response.status === 304 && method === 'GET') && !(response.status === 405 && method === 'MKCOL')) {
      const detail = response.status === 403 ? await this.errorReason(response) : '';
      if (response.status !== 403) await response.body?.cancel();
      throw Object.assign(new Error(`Sync server returned HTTP ${response.status} (${method} ${name || '/'}).${detail ? ' ' + detail : ''}`), { code: 'SYNC_HTTP', status: response.status, method, target: name || '/' });
    }
    return response;
  }
  async errorReason(response: Response) {
    // Inspect only known error categories. Never echo remote HTML, paths or credentials.
    const reader = response.body?.getReader(); if (!reader) return 'Check the WebDAV app password, folder permissions and service access limits.';
    let text = '', size = 0;
    try {
      while (size < 8192) {
        const { value, done } = await reader.read(); if (done) break;
        text += Buffer.from(value.subarray(0, 8192 - size)).toString(); size += value.length;
      }
    } catch { /* A malformed error body must not hide the HTTP status and failed operation. */
    } finally { await reader.cancel().catch(() => {}); }
    if (/too_many_requests|rate.?limit|request.*(?:frequency|too frequent)|访问频率|请求过于频繁/i.test(text)) return 'WebDAV request rate limit reached. Wait before trying again.';
    if (/quota|insufficient.?storage|storage.?limit|空间不足|流量.*(?:不足|超|用尽)/i.test(text)) return 'WebDAV storage or transfer quota is exhausted.';
    return 'Check the WebDAV app password, folder permissions and service access limits.';
  }
  async collectionExists(name, signal) {
    const response = await this.request('PROPFIND', name, '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>', { depth: '0', 'content-type': 'application/xml; charset=utf-8' }, signal);
    if (!response) return false;
    const xml = (await this.read(response)).toString();
    return /<(?:[\w-]+:)?collection\b[^>]*\/?\s*>/i.test(xml) && /HTTP\/\d(?:\.\d)?\s+200\b/i.test(xml);
  }
  async ensureCollection(name = '', signal?: AbortSignal) {
    if (await this.collectionExists(name, signal)) return;
    let response;
    try { response = await this.request('MKCOL', name, undefined, {}, signal); }
    catch (error) {
      if (error.status === 409 && !name) {
        const parentURL = new URL('..', this.url).href;
        if (parentURL !== this.url) {
          const parent = new SyncStorage({ ...this.config, url: parentURL }, this.fetch);
          await parent.ensureCollection('', signal);
          response = await this.request('MKCOL', name, undefined, {}, signal);
        } else throw error;
      } else if ([403, 409, 423].includes(error.status) && await this.collectionExists(name, signal)) return;
      else throw error;
    }
    if (!response || !response.ok && response.status !== 405) throw new Error('The sync collection is unavailable. Check the WebDAV folder permissions.');
    await response.body?.cancel();
  }
  async initialize(signal?: AbortSignal) {
    for (const name of ['', 'refs/', 'objects/']) await this.ensureCollection(name, signal);
    // Revision files use unique content hashes, so verification needs no overwrite operation.
    const name = 'refs/probe_' + randomBytes(12).toString('hex') + '.bin';
    let failure;
    try {
      await this.putImmutable(name, Buffer.from('fluid revision journal verification'), signal);
    } catch (error) { failure = error; throw error; } finally {
      try { await this.removeFiles([name], signal); }
      catch (error) { if (!failure) throw error; }
    }
  }
  async references(signal?: AbortSignal): Promise<StorageReference[]> {
    const response = await this.request('PROPFIND', 'refs/', '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>', { depth: '1', 'content-type': 'application/xml' }, signal);
    if (!response) return [];
    const xml = (await this.read(response)).toString(), names = new Map();
    let entries = 0;
    const decode = value => value.replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&').replace(/^<!\[CDATA\[|\]\]>$/g, '').trim();
    for (const block of xml.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)) {
      entries++;
      const href = /<(?:[\w-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?href>/i.exec(block[1]); if (!href) continue;
      let name; try { name = decodeURIComponent(decode(href[1])).split('/').at(-1); } catch { continue; }
      const property = /<(?:[\w-]+:)?getetag\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?getetag>/i.exec(block[1]);
      const reference = syncReference(name, property ? decode(property[1]) : null);
      if (reference) names.set(name, reference);
    }
    if (new URL(this.url).hostname === 'dav.jianguoyun.com' && entries >= 750) throw new Error('Nutstore reached its WebDAV directory listing limit. Synchronization is paused to preserve all revisions.');
    return [...names.values()];
  }
  async list(signal?: AbortSignal) { return (await this.references(signal)).filter(item => !item.deleted).map(item => item.id); }
  async read(response: Response) {
    if (Number(response.headers.get('content-length')) > maxPackage) { await response.body?.cancel(); throw new Error('Sync data exceeds 256 MiB.'); }
    const chunks = []; let size = 0;
    for await (const chunk of (response.body as ReadableStream<Uint8Array> || [])) { size += chunk.length; if (size > maxPackage) throw new Error('Sync data exceeds 256 MiB.'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  async get(name: string, signal?: AbortSignal, etag?: string): Promise<StorageObject | null> {
    const response = await this.request('GET', name, undefined, etag ? { 'if-none-match': etag } : {}, signal);
    if (!response) return null;
    if (response.status === 304) { await response.body?.cancel(); return { unchanged: true, etag }; }
    const revision = response.headers.get('etag');
    return { data: await this.read(response), etag: revision };
  }
  async removeFiles(names: string[], signal?: AbortSignal) {
    if (names.some(name => !syncFile.test(name))) throw new Error('Invalid sync object path.');
    for (const name of names) {
      const response = await this.request('DELETE', name, undefined, {}, signal);
      await response?.body?.cancel();
      if (response && ![200, 204].includes(response.status))
        throw new Error(`Sync server returned HTTP ${response.status} (DELETE ${name}).`);
    }
  }
  async putImmutable(name: string, data: Buffer, signal?: AbortSignal) {
    checkImmutable(name, data);
    let response;
    try { response = await this.request('PUT', name, data, { 'content-type': 'application/octet-stream', 'if-none-match': '*' }, signal); }
    catch (error) { if (error.code !== 'SYNC_CONFLICT') throw error; }
    if (response === null) throw new Error('The sync collection does not exist.');
    await response?.body?.cancel();
    const saved = await this.get(name, signal);
    if (!saved || digest(saved.data) !== digest(data)) throw new Error('The synchronized file failed its integrity check.');
  }
  async put(name, data, etag, signal) {
    if (data.length > maxPackage) throw new Error('Sync data exceeds 256 MiB.');
    const response = await this.request('PUT', name, data, { 'content-type': 'application/octet-stream', ...(etag ? { 'if-match': etag } : { 'if-none-match': '*' }) }, signal);
    if (!response) throw new Error('The sync collection does not exist.');
    const result = response.headers.get('etag'); await response.body?.cancel();
    if (result) return result;
    // ETag is optional on a successful PUT; read it back without weakening conditional writes.
    const saved = await this.get(name, signal);
    if (!saved || digest(saved.data) !== digest(data)) throw Object.assign(new Error('The remote task changed during sync. Both versions have been preserved.'), { code: 'SYNC_CONFLICT' });
    return saved.etag;
  }
}
