import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const syncID = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
export const maxPackage = 256 * 1024 * 1024;
const keys = new Map();
export function syncKey(password) {
  if (typeof password !== 'string' || password.length < 12) throw new Error('Use a sync passphrase of at least 12 characters.');
  const id = digest(password);
  if (!keys.has(id)) { if (keys.size >= 4) keys.delete(keys.keys().next().value); keys.set(id, scryptSync(password, 'easy-switch/task-sync/v1', 32)); }
  return keys.get(id);
}
export function seal(value, key) {
  const plaintext = JSON.stringify(value);
  if (Buffer.byteLength(plaintext) > maxPackage - 32) throw new Error('Sync data exceeds 256 MiB.');
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from('ESS1'), nonce, cipher.getAuthTag(), encrypted]);
}
export function unseal(data, key) {
  if (data.length < 32 || data.subarray(0, 4).toString() !== 'ESS1') throw new Error('Invalid encrypted sync data.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(4, 16));
    decipher.setAuthTag(data.subarray(16, 32));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(32)), decipher.final()]).toString());
  } catch { throw new Error('Unable to decrypt sync data. Check the shared sync passphrase.'); }
}
export function syncURL(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || !url.hostname ||
      url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    throw new Error('Use an HTTPS sync URL, or HTTP on localhost.');
  return url.href.replace(/\/*$/, '/');
}
export class SyncStorage {
  constructor(config, fetchImpl = fetch) { this.config = config; this.fetch = fetchImpl; this.url = syncURL(config.url); }
  async request(method, name = '', body, headers = {}, signal) {
    if (!/^(?:(?:refs|objects)\/(?:[a-zA-Z0-9_-]+(?:\.bin)?)?)?$/.test(name)) throw new Error('Invalid sync object path.');
    const authentication = this.config.kind === 'server' ? `Bearer ${this.config.secret}` : `Basic ${Buffer.from(`${this.config.username || ''}:${this.config.secret || ''}`).toString('base64')}`;
    let response;
    try {
      response = await this.fetch(this.url + name, { method, body, headers: { authorization: authentication, ...headers },
        redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error('Unable to reach the sync server. Check its address, credentials and connection.');
    }
    if (response.status === 412) { await response.body?.cancel(); const error = new Error('The remote task changed during sync. Both versions have been preserved.'); error.code = 'SYNC_CONFLICT'; throw error; }
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok && ![304, 405].includes(response.status)) { await response.body?.cancel(); throw new Error(`Sync server returned HTTP ${response.status}.`); }
    return response;
  }
  async initialize(signal) {
    for (const name of ['', 'refs/', 'objects/']) {
      const response = await this.request('MKCOL', name, undefined, {}, signal);
      if (!response || !response.ok && response.status !== 405) throw new Error('The sync collection is unavailable. Create the WebDAV parent directory first.');
      await response.body?.cancel();
    }
    // Conditional writes are required to avoid losing concurrent edits.
    const name = 'refs/probe_' + randomBytes(12).toString('hex') + '.bin';
    const first = await this.request('PUT', name, Buffer.from('probe'), { 'if-none-match': '*' }, signal);
    if (!first?.headers.get('etag')) throw new Error('The sync server must support ETags and conditional writes.');
    await first.body?.cancel();
    let conditional = false;
    try { await (await this.request('PUT', name, Buffer.from('probe'), { 'if-none-match': '*' }, signal))?.body?.cancel(); }
    catch (error) { if (error.code !== 'SYNC_CONFLICT') throw error; conditional = true; }
    await (await this.request('DELETE', name, undefined, {}, signal))?.body?.cancel();
    if (!conditional) throw new Error('This WebDAV server ignores conditional writes; automatic sync would lose edits.');
  }
  async list(signal) {
    const response = await this.request('PROPFIND', 'refs/', '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>', { depth: '1', 'content-type': 'application/xml' }, signal);
    if (!response) return [];
    const xml = (await this.read(response)).toString(), names = [];
    for (const match of xml.matchAll(/<(?:[\w-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?href>/gi)) {
      let name; try { name = decodeURIComponent(match[1].replaceAll('&amp;', '&').replace(/^<!\[CDATA\[|\]\]>$/g, '').trim()).split('/').at(-1); } catch { continue; }
      const id = name?.replace(/\.bin$/, '');
      if (name?.endsWith('.bin') && syncID(id) && !id.startsWith('probe_')) names.push(id);
    }
    return [...new Set(names)];
  }
  async read(response) {
    if (Number(response.headers.get('content-length')) > maxPackage) { await response.body?.cancel(); throw new Error('Sync data exceeds 256 MiB.'); }
    const chunks = []; let size = 0;
    for await (const chunk of response.body || []) { size += chunk.length; if (size > maxPackage) throw new Error('Sync data exceeds 256 MiB.'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  async get(name, signal, etag) {
    const response = await this.request('GET', name, undefined, etag ? { 'if-none-match': etag } : {}, signal);
    if (!response) return null;
    if (response.status === 304) { await response.body?.cancel(); return { unchanged: true, etag }; }
    const revision = response.headers.get('etag');
    if (!revision) { await response.body?.cancel(); throw new Error('The sync server did not return an ETag.'); }
    return { data: await this.read(response), etag: revision };
  }
  async put(name, data, etag, signal) {
    if (data.length > maxPackage) throw new Error('Sync data exceeds 256 MiB.');
    const response = await this.request('PUT', name, data, { 'content-type': 'application/octet-stream', ...(etag ? { 'if-match': etag } : { 'if-none-match': '*' }) }, signal);
    if (!response) throw new Error('The sync collection does not exist.');
    const result = response.headers.get('etag'); await response.body?.cancel();
    if (!result) throw new Error('The sync server did not return an ETag.');
    return result;
  }
}
