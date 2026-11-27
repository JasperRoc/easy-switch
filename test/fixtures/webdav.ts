import http from 'node:http';
import { once } from 'node:events';
import { digest } from '../../src/sync-storage.js';

export async function webdavFixture(t, { conditional = false } = {}) {
  const objects = new Map(), writes = [], reads = [];
  const collections = new Set(['/', '/dav/']);
  const username = 'fixture-user', secret = 'fixture-app-password';
  const authorization = 'Basic ' + Buffer.from(username + ':' + secret).toString('base64');
  const etag = bytes => '"' + digest(bytes) + '"';
  const server = http.createServer(async (req, res) => {
    const reply = (status, body = '', headers = {}) => { res.writeHead(status, headers); res.end(body); };
    if (req.headers.authorization !== authorization) return reply(401);
    const name = req.url, parent = name.slice(0, name.slice(0, -1).lastIndexOf('/') + 1);
    if (req.method === 'MKCOL') {
      if (collections.has(name)) return reply(405);
      if (!collections.has(parent)) return reply(409);
      collections.add(name); return reply(201);
    }
    if (req.method === 'PROPFIND') {
      if (!collections.has(name)) return reply(404);
      const response = (file, properties) => '<d:response><d:href>' + file + '</d:href><d:propstat><d:prop>' + properties +
        '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
      const files = req.headers.depth === '1' ? [...objects].filter(([file]) => file.startsWith(name)) : [];
      return reply(207, '<d:multistatus xmlns:d="DAV:">' + response(name, '<d:resourcetype><d:collection/></d:resourcetype>') +
        files.map(([file, bytes]) => response(file, conditional ? '<d:getetag>' + etag(bytes) + '</d:getetag>' : '')).join('') + '</d:multistatus>');
    }
    if (!collections.has(parent)) return reply(404);
    const previous = objects.get(name);
    if (req.method === 'PUT') {
      if (conditional && (req.headers['if-none-match'] === '*' && previous ||
          req.headers['if-match'] && (!previous || req.headers['if-match'] !== etag(previous)))) return reply(412);
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      objects.set(name, bytes); writes.push(name); return reply(201, '', conditional ? { etag: etag(bytes) } : {});
    }
    if (req.method === 'GET') {
      reads.push(name);
      if (!previous) return reply(404);
      if (conditional && req.headers['if-none-match'] === etag(previous)) return reply(304);
      return reply(200, previous, conditional ? { etag: etag(previous) } : {});
    }
    if (req.method === 'DELETE') return reply(objects.delete(name) ? 204 : 404);
    reply(405);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/dav/`;
  const config = { kind: 'webdav', url: base + 'fluid/', username, secret, passphrase: 'fixture shared passphrase', enabled: true };
  return { config, base, objects, writes, reads, collections };
}
