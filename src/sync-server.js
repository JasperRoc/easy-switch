import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { digest, maxPackage } from './sync-storage.js';

// Only this optional server requires Node's SQLite module; clients keep Node 20 support.
export async function createSyncServer({ database, token }) {
  if (typeof token !== 'string' || token.length < 24) throw new Error('Set SWITCH_SYNC_TOKEN to a random secret of at least 24 characters.');
  const { DatabaseSync } = await import('node:sqlite').catch(() => { throw new Error('The sync server requires Node.js 22.13 or later.'); });
  fs.mkdirSync(path.dirname(path.resolve(database)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(database);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS objects (name TEXT PRIMARY KEY, etag TEXT NOT NULL, data BLOB NOT NULL)');
  try { fs.chmodSync(database, 0o600); } catch {}
  const server = http.createServer(async (req, res) => {
    const reply = (status, data = '', headers = {}) => { res.writeHead(status, { 'cache-control': 'no-store', ...headers }); res.end(data); };
    const actual = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply(401);
    const name = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (!/^(?:(?:refs|objects)\/(?:[a-zA-Z0-9_-]+\.bin)?)?$/.test(name)) return reply(404);
    try {
      if (req.method === 'MKCOL' && ['', 'refs/', 'objects/'].includes(name)) return reply(201);
      if (req.method === 'PROPFIND' && name === 'refs/') {
        const names = db.prepare("SELECT name,etag FROM objects WHERE name LIKE 'refs/%'").all();
        return reply(207, '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">' + names.map(item => `<d:response><d:href>/${item.name}</d:href><d:propstat><d:prop><d:getetag>${item.etag.replaceAll('"', '&quot;')}</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('') + '</d:multistatus>', { 'content-type': 'application/xml' });
      }
      if (!name.endsWith('.bin')) return reply(404);
      if (req.method === 'GET') {
        const item = db.prepare('SELECT etag,data FROM objects WHERE name=?').get(name);
        if (item && req.headers['if-none-match'] === item.etag) return reply(304, '', { etag: item.etag });
        return item ? reply(200, item.data, { etag: item.etag, 'content-type': 'application/octet-stream' }) : reply(404);
      }
      if (req.method === 'PUT') {
        if (!req.headers['if-match'] && req.headers['if-none-match'] !== '*') return reply(428);
        if (Number(req.headers['content-length']) > maxPackage) return reply(413);
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > maxPackage) return reply(413); chunks.push(chunk); }
        const data = Buffer.concat(chunks), etag = '"' + digest(data) + '"';
        db.exec('BEGIN IMMEDIATE');
        try {
          const current = db.prepare('SELECT etag FROM objects WHERE name=?').get(name);
          if (req.headers['if-none-match'] === '*' ? !!current : current?.etag !== req.headers['if-match']) { db.exec('ROLLBACK'); return reply(412); }
          db.prepare('INSERT INTO objects(name,etag,data) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET etag=excluded.etag,data=excluded.data').run(name, etag, data);
          db.exec('COMMIT'); return reply(201, '', { etag });
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      if (req.method === 'DELETE' && name.startsWith('refs/probe_')) { db.prepare('DELETE FROM objects WHERE name=?').run(name); return reply(204); }
      return reply(405);
    } catch { if (!res.headersSent) reply(500); else res.destroy(); }
  });
  server.requestTimeout = 60000;
  server.on('close', () => db.close());
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const server = await createSyncServer({ database: process.env.SWITCH_SYNC_DATABASE || './easy-switch-sync.sqlite', token: process.env.SWITCH_SYNC_TOKEN });
    const port = Number(process.env.SWITCH_SYNC_PORT || 18445);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SWITCH_SYNC_PORT.');
    server.listen(port, process.env.SWITCH_SYNC_HOST || '127.0.0.1', () => console.log(`easy-switch sync server listening on port ${port}`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
