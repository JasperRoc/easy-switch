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
      response = await this.fetch(this.url + name, { method, body, headers: { authorization: authentication, 'user-agent': 'easy-switch/1 WebDAV', ...headers },
        redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error('Unable to reach the sync server. Check its address, credentials and connection.');
    }
    if (response.status === 412) { await response.body?.cancel(); const error = new Error('The remote task changed during sync. Both versions have been preserved.'); error.code = 'SYNC_CONFLICT'; throw error; }
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok && !(response.status === 304 && method === 'GET') && !(response.status === 405 && method === 'MKCOL')) {
      const detail = response.status === 403 ? await this.errorReason(response) : '';
      if (response.status !== 403) await response.body?.cancel();
      throw Object.assign(new Error(`Sync server returned HTTP ${response.status} (${method} ${name || '/'}).${detail ? ' ' + detail : ''}`), { code: 'SYNC_HTTP', status: response.status, method, target: name || '/' });
    }
    return response;
  }
  async errorReason(response) {
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
  async initialize(signal) {
    for (const name of ['', 'refs/', 'objects/']) {
      if (this.config.kind === 'webdav' && await this.collectionExists(name, signal)) continue;
      let response;
      try { response = await this.request('MKCOL', name, undefined, {}, signal); }
      catch (error) {
        // Providers vary in their response to an existing collection or a concurrent create.
        if (this.config.kind === 'webdav' && [403, 409, 423].includes(error.status)) {
          try { if (await this.collectionExists(name, signal)) continue; } catch { signal?.throwIfAborted(); }
        }
        throw error;
      }
      if (!response || !response.ok && response.status !== 405) throw new Error('The sync collection is unavailable. Create the WebDAV parent directory first.');
      await response.body?.cancel();
    }
    // Revision files use unique content hashes, so verification needs no overwrite operation.
    const name = 'refs/probe_' + randomBytes(12).toString('hex') + '.bin';
    let failure;
    try {
      await this.putImmutable(name, Buffer.from('easy-switch revision journal verification'), signal);
    } catch (error) { failure = error; throw error; } finally {
      try { await (await this.request('DELETE', name, undefined, {}, signal))?.body?.cancel(); }
      catch (error) { if (!failure) throw error; }
    }
  }
  async references(signal) {
    const response = await this.request('PROPFIND', 'refs/', '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>', { depth: '1', 'content-type': 'application/xml' }, signal);
    if (!response) return [];
    const xml = (await this.read(response)).toString(), names = new Map();
    let entries = 0;
    const decode = value => value.replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&').replace(/^<!\[CDATA\[|\]\]>$/g, '').trim();
    for (const block of xml.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)) {
      entries++;
      const href = /<(?:[\w-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?href>/i.exec(block[1]); if (!href) continue;
      let name; try { name = decodeURIComponent(decode(href[1])).split('/').at(-1); } catch { continue; }
      const id = name?.replace(/\.bin$/, '');
      const property = /<(?:[\w-]+:)?getetag\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?getetag>/i.exec(block[1]);
      if (name?.endsWith('.bin') && syncID(id) && !id.startsWith('probe_')) names.set(id, { id, etag: property ? decode(property[1]) : null });
    }
    if (new URL(this.url).hostname === 'dav.jianguoyun.com' && entries >= 750) throw new Error('Nutstore reached its WebDAV directory listing limit. Synchronization is paused to preserve all revisions.');
    return [...names.values()];
  }
  async list(signal) { return (await this.references(signal)).map(item => item.id); }
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
    return { data: await this.read(response), etag: revision };
  }
  async putImmutable(name, data, signal) {
    if (data.length > maxPackage) throw new Error('Sync data exceeds 256 MiB.');
    const probe = /^refs\/probe_[a-f0-9]+\.bin$/.test(name);
    if (!probe && !/^(?:refs|objects)\/[a-f0-9]{64}\.bin$/.test(name)) throw new Error('Immutable sync files require a content hash.');
    if (!probe && name.split('/')[1] !== digest(data) + '.bin') throw new Error('The sync filename does not match its content.');
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
