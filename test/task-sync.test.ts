import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { TaskSync } from '../src/task-sync.js';
import { webdavFixture } from './fixtures/webdav.js';
import { SyncStorage, syncKey, seal, unseal, digest } from '../src/sync-storage.js';
import { webdavLibraryURL } from '../src/sync-url.js';
import { projectSnapshot, restoreProject } from '../src/sync-project.js';
import { CodexTasks, relocateWorkspaceRoots, withWindowsWriter } from '../src/sync-codex.js';
import { checkpoint, expandContext } from '../src/compaction.js';
import { SyncJournal } from '../src/sync-journal.js';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-C', cwd, ...args], { encoding: 'utf8' }).trim();
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fluid-sync-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function repository(root) {
  fs.mkdirSync(root, { recursive: true }); git(root, 'init', '-q'); git(root, 'config', 'user.email', 'test@example.test'); git(root, 'config', 'user.name', 'Sync Test');
  fs.writeFileSync(path.join(root, 'file.txt'), 'base\n'); fs.writeFileSync(path.join(root, '.gitignore'), '.env\nignored\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Initial fixture'); return root;
}
test('WebDAV uses the configured folder and Basic authentication without requiring conditional writes', async t => {
  const objects = new Map(); let ignoresConditions = false;
  const server = http.createServer(async (req, res) => {
    const reply = (status, data = '', headers = {}) => { res.writeHead(status, headers); res.end(data); };
    if (req.headers.authorization !== 'Basic ' + Buffer.from('user:app-password').toString('base64')) return reply(401);
    if (!req.url.startsWith('/library/fluid/')) return reply(404);
    const name = req.url.slice('/library/fluid/'.length);
    if (req.method === 'MKCOL') return reply(405);
    if (req.method === 'PROPFIND') return reply(207, '<multistatus xmlns="DAV:">' + [...objects.keys()].map(name => '<response><href>/library/fluid/' + name + '</href></response>').join('') + '</multistatus>');
    if (req.method === 'DELETE') { objects.delete(name); return reply(204); }
    const current = objects.get(name);
    if (req.method === 'GET') return current ? reply(200, current.data, { etag: current.etag }) : reply(404);
    if (req.method === 'PUT') {
      if (!ignoresConditions && (req.headers['if-none-match'] === '*' ? !!current : current?.etag !== req.headers['if-match'])) return reply(412);
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const data = Buffer.concat(chunks), etag = '"' + digest(data) + '"'; objects.set(name, { data, etag }); return reply(201, '', { etag });
    }
    reply(405);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new SyncStorage({ kind: 'webdav', url: `http://127.0.0.1:${server.address().port}/library/fluid/`, username: 'user', secret: 'app-password' });
  await client.initialize(); await client.put('refs/selected.bin', Buffer.from('encrypted fixture')); assert.deepEqual(await client.list(), ['selected']);
  assert.equal((await client.get('refs/selected.bin')).data.toString(), 'encrypted fixture');
  ignoresConditions = true; await client.initialize();
});
test('WebDAV checks existing collections before MKCOL and reads ETags omitted from PUT responses', async t => {
  const root = '/dav/fluid/', collections = new Set([root]), objects = new Map(), calls = [];
  const server = http.createServer(async (req, res) => {
    const reply = (status, data = '', headers = {}) => { res.writeHead(status, headers); res.end(data); };
    calls.push([req.method, req.url]);
    assert.match(req.headers['user-agent'], /^fluid\//);
    if (req.method === 'PROPFIND') return collections.has(req.url) ? reply(207, '<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>') : reply(404);
    if (req.method === 'MKCOL') {
      if (collections.has(req.url)) return reply(403, '<d:error xmlns:d="DAV:"><d:collection-already-exists/></d:error>');
      collections.add(req.url); return reply(201);
    }
    if (req.method === 'DELETE') { objects.delete(req.url); return reply(204); }
    const current = objects.get(req.url);
    if (req.method === 'GET') return current ? reply(200, current.data, { etag: current.etag }) : reply(404);
    if (req.method === 'PUT') {
      if (req.headers['if-none-match'] === '*' ? !!current : current?.etag !== req.headers['if-match']) return reply(412);
      const chunks = []; for await (const chunk of req) chunks.push(chunk); const data = Buffer.concat(chunks);
      objects.set(req.url, { data, etag: '"' + digest(data) + '"' }); return reply(201);
    }
    reply(405);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new SyncStorage({ kind: 'webdav', url: `http://127.0.0.1:${server.address().port}${root}`, username: 'user', secret: 'app-password' });
  await client.initialize(); await client.initialize();
  assert.deepEqual(calls.filter(([method]) => method === 'MKCOL').map(([, name]) => name), [root + 'refs/', root + 'objects/']);
  assert.equal(objects.size, 0, 'verification files are removed');
});
test('WebDAV creates missing parent folders and both client namespaces automatically', async t => {
  const { config, base, collections } = await webdavFixture(t);
  const root = base + 'new/folder/fluid/';
  await new SyncStorage({ ...config, url: root }).initialize();
  await new SyncStorage({ ...config, url: root + 'claude/' }).initialize();
  for (const folder of ['new/', 'new/folder/', 'new/folder/fluid/', 'new/folder/fluid/refs/', 'new/folder/fluid/objects/',
    'new/folder/fluid/claude/', 'new/folder/fluid/claude/refs/', 'new/folder/fluid/claude/objects/'])
    assert.ok(collections.has(new URL(base + folder).pathname), folder);
});
test('cold journal reads use bounded concurrency and reuse verified encrypted files after restart', async t => {
  const directory = path.join(fixture(t), 'journal'), key = syncKey('journal cache passphrase');
  const objects = new Map(), refs = [];
  for (let i = 0; i < 7; i++) {
    const data = seal({ version: 2, id: 'task-' + i, parents: [], revision: 'b'.repeat(64), projectKey: 'c'.repeat(64), object: 'd'.repeat(64), title: 'Task ' + i }, key);
    const id = digest(data); refs.push({ id, etag: null }); objects.set(id, data);
  }
  let active = 0, peak = 0, reads = 0;
  const storage = { references: async () => refs, get: async name => {
    reads++; peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return { data: objects.get(name.slice(5, -4)), etag: null };
  } };
  assert.equal((await new SyncJournal(storage, key, new Map(), directory).read()).size, 7);
  assert.equal(reads, 7); assert.equal(peak, 3);
  const files = fs.readdirSync(directory); assert.equal(files.length, 7);
  assert.equal(fs.readFileSync(path.join(directory, files[0])).subarray(0, 4).toString(), 'ESS1');
  assert.equal((await new SyncJournal(storage, key, new Map(), directory).read()).size, 7);
  assert.equal(reads, 7, 'restarting reuses encrypted immutable references');
  fs.writeFileSync(path.join(directory, files[0]), 'damaged cache');
  await new SyncJournal(storage, key, new Map(), directory).read();
  assert.equal(reads, 8, 'a damaged cache entry is fetched and verified again');
  refs.pop();
  assert.equal((await new SyncJournal(storage, key, new Map(), directory).read()).size, 6);
  assert.equal(fs.readdirSync(directory).length, 6, 'remote listing controls which cached revisions remain live');
  await assert.rejects(new SyncJournal(storage, syncKey('incorrect cache passphrase'), new Map(), directory).read(), /decrypt/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(new SyncJournal(storage, key, new Map(), directory).read(abort.signal), { name: 'AbortError' });
});
test('a 403 identifies the failing WebDAV operation without exposing the response or credentials', async () => {
  const base = { kind: 'webdav', url: 'https://dav.example.test/fluid/', username: 'private-user', secret: 'private-password' };
  for (const [body, expected] of [['<error>private-password private-user</error>', /app password, folder permissions/],
    ['<error>too_many_requests</error>', /rate limit/], ['<error>insufficient_storage</error>', /quota/]]) {
    const client = new SyncStorage(base, async () => new Response(body, { status: 403 }));
    await assert.rejects(client.initialize(), error => {
      assert.equal(error.status, 403); assert.equal(error.method, 'PROPFIND');
      assert.match(error.message, /403 \(PROPFIND \/\)/); assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /private-password|private-user|<error>/); return true;
    });
  }
  const client = new SyncStorage(base, async (_url, options) => options.method === 'PROPFIND' ? new Response('', { status: 404 }) : new Response('', { status: 403 }));
  await assert.rejects(client.initialize(), error => error.method === 'MKCOL' && error.status === 403, 'a failed directory create is not silently ignored');
});
test('unchanged WebDAV references use listing ETags without one GET per task', async t => {
  const root = fixture(t), key = syncKey('fixture shared passphrase'), id = 'selected-task'; let reads = 0;
  const ref = { version: 1, id, title: 'Remote task', projectKey: 'a'.repeat(64), revision: 'b'.repeat(64), object: 'c'.repeat(64) };
  const sync = new TaskSync({ root, tasks: { list: async () => [] }, fetchImpl: async (_url, options) => {
    if (options.method === 'PROPFIND') return new Response('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/refs/selected-task.bin</d:href><d:propstat><d:prop><d:getetag>&quot;stable&quot;</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>', { status: 207 });
    if (!_url.includes('/refs/')) return new Response(null, { status: 404 });
    reads++; return new Response(seal(ref, key), { headers: { etag: '"stable"' } });
  } });
  t.after(() => sync.close()); sync.config = { ...sync.config, kind: 'webdav', url: 'https://dav.example.test/library/', username: 'user', secret: 'password', passphrase: 'fixture shared passphrase', enabled: true }; sync.save();
  await sync.run(); await sync.run();
  assert.equal(reads, 1, 'unchanged references are cached while the missing package is retried');
  assert.match(sync.snapshot().tasks[0].message, /package is incomplete/);
});
test('immutable revision journals retain concurrent versions when WebDAV ignores preconditions and omits ETags', async t => {
  const { config, objects, writes, reads } = await webdavFixture(t), storage = new SyncStorage(config);
  const key = syncKey('journal fixture passphrase'), a = new SyncJournal(storage, key), b = new SyncJournal(storage, key);
  const ref = { id: 'shared-task', title: 'Fixture', projectKey: 'a'.repeat(64), revision: 'b'.repeat(64), object: 'c'.repeat(64), updatedAt: 1, device: 'a' };
  await storage.initialize();
  const base = await a.publish(ref);
  assert.equal((await b.read()).get(ref.id).revision, ref.revision);
  await Promise.all([a.publish({ ...ref, revision: 'd'.repeat(64), updatedAt: 2 }, base.heads), b.publish({ ...ref, revision: 'e'.repeat(64), device: 'b', updatedAt: 3 }, base.heads)]);
  const conflict = (await a.read()).get(ref.id);
  assert.equal(conflict.conflict, true); assert.equal(conflict.heads.length, 2);
  assert.equal(objects.size, 3); assert.equal(new Set(writes).size, writes.length, 'no shared pointer was overwritten');
  await b.publish(conflict, conflict.heads);
  const resolved = (await a.read()).get(ref.id);
  assert.equal(resolved.conflict, false); assert.equal(resolved.heads.length, 1); assert.equal(resolved.revision, 'e'.repeat(64));
  assert.equal(objects.size, 4, 'resolving preserves all prior revisions');
  const count = reads.length; await a.read(); assert.equal(reads.length, count, 'immutable metadata is cached even without ETags');
  await assert.rejects(new SyncJournal(storage, syncKey('incorrect fixture passphrase')).read(), /decrypt/);
  const name = new URL(config.url).pathname + 'refs/' + resolved.node + '.bin'; objects.set(name, Buffer.from('corrupted data'));
  await assert.rejects(new SyncJournal(storage, key).read(), /encrypted sync data/);
});
test('immutable uploads reject content mismatches and Nutstore refuses truncated revision listings', async () => {
  const bytes = Buffer.from('expected content'), config = { kind: 'webdav', url: 'https://dav.example.test/', username: 'user', secret: 'password' };
  const client = new SyncStorage(config, async (_url, options) => options.method === 'PUT' ? new Response('', { status: 201 }) : new Response('different content'));
  await assert.rejects(client.putImmutable('refs/' + digest(bytes) + '.bin', bytes), /integrity check/);
  await assert.rejects(client.putImmutable('refs/' + 'a'.repeat(64) + '.bin', bytes), /filename does not match/);
  const xml = '<d:multistatus xmlns:d="DAV:">' + Array.from({ length: 750 }, (_, i) => `<d:response><d:href>/refs/${i}.bin</d:href></d:response>`).join('') + '</d:multistatus>';
  const nutstore = new SyncStorage({ ...config, url: 'https://dav.jianguoyun.com/dav/fluid/' }, async () => new Response(xml, { status: 207 }));
  await assert.rejects(nutstore.references(), /directory listing limit/);
  const missing = new SyncStorage(config, async (_url, options) => options.method === 'PROPFIND' ? new Response('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/refs/task.bin</d:href></d:response></d:multistatus>', { status: 207 }) : new Response('', { status: 404 }));
  await assert.rejects(new SyncJournal(missing, syncKey('missing fixture passphrase')).read(), /journal is incomplete/);
});
test('a missing journal parent blocks loading and legacy revision pointers stay readable', async t => {
  const { config } = await webdavFixture(t), client = new SyncStorage(config), key = syncKey(config.passphrase);
  await client.initialize();
  const ref = { version: 1, id: 'legacy-task', title: 'Legacy', revision: 'a'.repeat(64), projectKey: 'b'.repeat(64), object: 'c'.repeat(64) };
  await client.put('refs/legacy-task.bin', seal(ref, key));
  const journal = new SyncJournal(client, key), legacy = (await journal.read()).get(ref.id);
  const next = await journal.publish({ ...ref, revision: 'd'.repeat(64) }, legacy.heads);
  assert.equal((await journal.read()).get(ref.id).revision, next.revision);
  await journal.publish({ ...ref, revision: 'e'.repeat(64) }, ['f'.repeat(64)]);
  await assert.rejects(journal.read(), /journal is incomplete/);
});
test('removed revisions can be pruned after a late write or interrupted cleanup', async t => {
  const { config, objects } = await webdavFixture(t, { conditional: true });
  const storage = new SyncStorage(config), key = syncKey(config.passphrase);
  await storage.initialize();
  const current = new SyncJournal(storage, key), offline = new SyncJournal(storage, key);
  const object = async id => {
    const bytes = seal({ id, history: 'fixture' }, key), hash = digest(bytes);
    await storage.putImmutable(`objects/${hash}.bin`, bytes);
    return hash;
  };
  const ref = { id: 'removed', title: 'Remove me', projectKey: 'a'.repeat(64), revision: 'b'.repeat(64), updatedAt: 1, device: 'a', object: await object('removed') };
  const original = await current.publish(ref);
  const shared = await current.publish({ ...ref, id: 'keep', title: 'Other task' });
  await offline.read();
  await current.markRemoved(ref.id); await current.read(); await current.prune(ref.id);
  assert.equal(await storage.get(`refs/${original.node}.bin`), null);
  assert.ok(await storage.get(`objects/${shared.object}.bin`));
  const late = await offline.publish({ ...ref, object: await object('late-upload') }, original.heads);
  assert.equal((await current.read()).has(ref.id), false, 'late publication is ignored even if ancestors were removed');
  const remove = storage.removeFiles.bind(storage);
  t.mock.method(storage, 'removeFiles', async names => {
    if (names.includes(`refs/${late.node}.bin`)) throw new Error('fixture disconnect');
    return remove(names);
  });
  await assert.rejects(current.prune(ref.id), /fixture disconnect/);
  assert.equal(await storage.get(`objects/${late.object}.bin`), null);
  assert.ok(await storage.get(`refs/${late.node}.bin`));
  storage.removeFiles.mock.restore();
  const restarted = new SyncJournal(storage, key);
  assert.deepEqual([...(await restarted.read()).keys()], ['keep']);
  await restarted.prune(ref.id);
  assert.equal(await storage.get(`refs/${late.node}.bin`), null);
  const [marker] = [...objects.keys()].filter(name => name.endsWith('.deleted'));
  const markerBytes = objects.get(marker);
  assert.deepEqual(unseal(markerBytes, key), { id: ref.id, version: 1 });
  const restored = await restarted.publish({ ...ref, object: await object('new-revision') });
  assert.equal((await restarted.read()).get(ref.id).node, restored.node);
  objects.delete(marker);
  await assert.rejects(restarted.read(), /journal is incomplete/, 'a partial listing cannot sweep a newer publication');
  objects.set(marker, markerBytes);
});
test('unconfigured task sync performs no background enumeration or network requests', async t => {
  const root = fixture(t); let calls = 0;
  const sync = new TaskSync({ root, interval: 5, tasks: { list: async () => { calls++; return []; } }, fetchImpl: async () => { calls++; throw Error('Unexpected request'); } });
  sync.start(); await new Promise(resolve => setTimeout(resolve, 30)); await sync.close();
  assert.equal(calls, 0); assert.equal(sync.timer, undefined);
});
test('encrypted WebDAV objects support authentication and conditional writes', async t => {
  const { config } = await webdavFixture(t, { conditional: true }), client = new SyncStorage(config);
  await client.initialize();
  const key = syncKey(config.passphrase), bytes = seal({ title: 'private task', secret: 'private content' }, key);
  assert.doesNotMatch(bytes.toString(), /private task|private content/);
  const etag = await client.put('refs/task.bin', bytes);
  assert.equal((await client.get('refs/task.bin', undefined, etag)).unchanged, true);
  assert.deepEqual(await client.list(), ['task']); assert.deepEqual(unseal((await client.get('refs/task.bin')).data, key), { title: 'private task', secret: 'private content' });
  await assert.rejects(client.put('refs/task.bin', bytes), error => error.code === 'SYNC_CONFLICT');
  await assert.rejects(client.put('refs/task.bin', bytes, '"wrong"'), error => error.code === 'SYNC_CONFLICT');
  await client.put('refs/task.bin', bytes, etag);
  assert.throws(() => unseal(bytes, syncKey('another wrong passphrase')), /decrypt/);
  const denied = await fetch(config.url + 'refs/task.bin'); assert.equal(denied.status, 401);
  await assert.rejects(client.removeFiles(['refs/../other.bin']), /Invalid sync object path/);
});
test('WebDAV base addresses use a dedicated library and previously saved folders remain accessible', async t => {
  const addresses = ['https://dav.jianguoyun.com/dav', 'https://dav.jianguoyun.com/dav/', 'https://dav.jianguoyun.com/dav/fluid/'];
  for (const address of addresses) assert.equal(webdavLibraryURL(address), addresses[2]);
  assert.equal(webdavLibraryURL('https://dav.example.test/'), 'https://dav.example.test/fluid/');
  assert.throws(() => webdavLibraryURL('https://name:password@dav.example.test/'), /Use an HTTPS sync URL/);
  const { base, config, collections } = await webdavFixture(t);
  const sync = new TaskSync({ root: fixture(t), tasks: { list: async () => [] } });
  t.after(() => sync.close());
  const saved = await sync.configure({ ...config, url: base });
  assert.equal(saved.url, config.url);
  assert.ok(collections.has('/dav/fluid/'));
  assert.equal((await sync.configure({ ...saved, passphrase: '' })).url, config.url);
  sync.config = { ...sync.config, url: base }; sync.save();
  assert.equal((await sync.configure({ ...config, url: base })).url, base, 'an installed library can be reverified in place');
});
test('only a verified storage replacement changes the active location', async t => {
  const root = fixture(t), { config: first } = await webdavFixture(t), { config: second } = await webdavFixture(t);
  const sync = new TaskSync({ root, tasks: { list: async () => [] } });
  t.after(() => sync.close());
  await sync.configure(first);
  await assert.rejects(sync.configure({ ...second, secret: 'incorrect' }), /HTTP 401/);
  assert.equal(sync.snapshot().url, first.url);
  assert.equal(sync.load().url, first.url);
  assert.equal((await sync.configure(second)).url, second.url);
  await assert.rejects(sync.removeRemote({ id: 'task', storage: first }), /Sync storage changed/);
});
test('a saved HTTPS service pauses without network access until a supported store is verified', async t => {
  const root = fixture(t), { config } = await webdavFixture(t);
  const legacy = { kind: 'server', url: 'https://previous.example.test/', passphrase: config.passphrase, secret: 'old-token', enabled: true, selected: { task: { enabled: true } } };
  fs.writeFileSync(path.join(root, 'sync.json'), JSON.stringify(legacy));
  let contacts = 0;
  const sync = new TaskSync({ root, tasks: { list: async () => [] }, fetchImpl: (url, options) => {
    contacts++; assert.ok(url.startsWith(config.url)); return fetch(url, options);
  } });
  t.after(() => sync.close());
  sync.start();
  const paused = await sync.run();
  assert.equal(contacts, 0); assert.equal(paused.configured, false); assert.equal(paused.enabled, false);
  assert.equal(paused.legacyStorage, true);
  assert.doesNotMatch(JSON.stringify(paused), /old-token|previous\.example/);
  await assert.rejects(sync.configure(legacy), /Choose a sync storage method/);
  assert.equal(sync.load().kind, 'server');
  const saved = await sync.configure({ ...config, passphrase: '' });
  assert.equal(saved.kind, 'webdav'); assert.equal(saved.legacyStorage, false);
  assert.deepEqual(sync.load().selected, {});
});
test('Git sync preserves commit, staged and unstaged binary changes, untracked files and ignored local secrets', async t => {
  const root = fixture(t), source = repository(path.join(root, 'source')), cache = path.join(root, 'cache'), target = path.join(root, 'target');
  fs.mkdirSync(cache);
  fs.writeFileSync(path.join(source, 'file.txt'), 'staged\n'); git(source, 'add', 'file.txt');
  fs.appendFileSync(path.join(source, 'file.txt'), 'unstaged\n'); fs.writeFileSync(path.join(source, 'new.bin'), Buffer.from([0, 1, 255]));
  fs.writeFileSync(path.join(source, '.env'), 'SECRET=private');
  const first = await projectSnapshot(source, cache); assert.ok(!JSON.stringify(first.files).includes('SECRET'));
  assert.equal(first.relative, '');
  const nested = path.join(source, 'nested', 'work');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal((await projectSnapshot(nested, cache, false)).relative, 'nested/work');
  await restoreProject(first, target, cache);
  assert.equal(git(target, 'rev-parse', 'HEAD'), git(source, 'rev-parse', 'HEAD'));
  assert.equal(git(target, 'diff', '--cached'), git(source, 'diff', '--cached'));
  assert.equal(git(target, 'diff'), git(source, 'diff')); assert.deepEqual(fs.readFileSync(path.join(target, 'new.bin')), Buffer.from([0, 1, 255]));
  assert.equal(fs.existsSync(path.join(target, '.env')), false);
  assert.equal((await projectSnapshot(target, cache)).fingerprint, first.fingerprint);
  fs.writeFileSync(path.join(target, '.env'), 'LOCAL=keep');
  fs.writeFileSync(path.join(source, 'file.txt'), 'next version\n');
  const second = await projectSnapshot(source, cache); await restoreProject(second, target, cache, first.fingerprint);
  assert.equal(fs.readFileSync(path.join(target, '.env'), 'utf8'), 'LOCAL=keep');
  fs.writeFileSync(path.join(target, 'file.txt'), 'local divergent change\n');
  await assert.rejects(restoreProject(first, target, cache, second.fingerprint), /conflict/);
  assert.equal(fs.readFileSync(path.join(target, 'file.txt'), 'utf8'), 'local divergent change\n');
});
test('ordinary folders sync files without creating Git metadata and preserve ignored local files', async t => {
  const root = fixture(t), source = path.join(root, 'plain'), target = path.join(root, 'restored'), cache = path.join(root, 'cache');
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true }); fs.mkdirSync(path.join(source, 'node_modules'));
  fs.writeFileSync(path.join(source, '.gitignore'), 'ignored\n'); fs.writeFileSync(path.join(source, 'ignored'), 'private');
  fs.writeFileSync(path.join(source, '.env'), 'PRIVATE=source'); fs.writeFileSync(path.join(source, 'node_modules', 'dependency'), 'ignored');
  fs.writeFileSync(path.join(source, 'nested', 'file.bin'), Buffer.from([0, 255, 1]));
  const first = await projectSnapshot(source, cache);
  assert.equal(first.kind, 'folder'); assert.equal(first.bundle, undefined); assert.equal(fs.existsSync(path.join(source, '.git')), false);
  assert.deepEqual(first.files.map(file => file.name), ['.gitignore', 'nested/file.bin']);
  await restoreProject(first, target, cache);
  assert.equal(fs.existsSync(path.join(target, '.git')), false);
  assert.deepEqual(fs.readFileSync(path.join(target, 'nested', 'file.bin')), Buffer.from([0, 255, 1]));
  assert.equal((await projectSnapshot(target, cache)).fingerprint, first.fingerprint);
  fs.writeFileSync(path.join(target, '.env'), 'PRIVATE=destination'); fs.writeFileSync(path.join(target, 'ignored'), 'local ignored');
  fs.writeFileSync(path.join(source, 'nested', 'file.bin'), 'next'); fs.writeFileSync(path.join(source, 'new.txt'), 'new');
  const second = await projectSnapshot(source, cache); await restoreProject(second, target, cache, first.fingerprint);
  assert.equal(fs.readFileSync(path.join(target, '.env'), 'utf8'), 'PRIVATE=destination'); assert.equal(fs.readFileSync(path.join(target, 'ignored'), 'utf8'), 'local ignored');
  assert.equal((await projectSnapshot(target, cache)).fingerprint, second.fingerprint);
  fs.writeFileSync(path.join(target, 'new.txt'), 'local change');
  await assert.rejects(restoreProject(first, target, cache, second.fingerprint), /conflict/);
  assert.equal(fs.readFileSync(path.join(target, 'new.txt'), 'utf8'), 'local change');
  await assert.rejects(restoreProject({ ...first, files: [{ name: '../escape', mode: 0o600, data: '' }] }, path.join(root, 'malicious'), cache), /Unsafe project/);
});
test('empty folders and Git projects without a first commit can synchronize', async t => {
  const root = fixture(t), source = path.join(root, 'empty'), cache = path.join(root, 'cache'); fs.mkdirSync(source);
  const empty = await projectSnapshot(source, cache); assert.equal(empty.kind, 'folder'); assert.deepEqual(empty.files, []);
  await restoreProject(empty, path.join(root, 'empty-restored'), cache);
  git(source, 'init', '-q'); fs.writeFileSync(path.join(source, 'uncommitted.txt'), 'not committed'); git(source, 'add', '.');
  const before = git(source, 'status', '--porcelain');
  const snapshot = await projectSnapshot(source, cache); assert.equal(snapshot.kind, 'folder'); assert.equal(snapshot.files[0].name, 'uncommitted.txt');
  await restoreProject(snapshot, path.join(root, 'unborn-restored'), cache);
  assert.equal(git(source, 'status', '--porcelain'), before, 'the original index is unchanged');
  assert.equal(fs.existsSync(path.join(root, 'unborn-restored', '.git')), false);
  git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.test'); git(source, 'commit', '-qm', 'First commit');
  const committed = await projectSnapshot(source, cache);
  await restoreProject(committed, path.join(root, 'unborn-restored'), cache, snapshot.fingerprint);
  assert.equal(git(path.join(root, 'unborn-restored'), 'rev-parse', 'HEAD'), committed.head);
});
test('portable Codex checkpoints survive machines with different local proxy tokens', () => {
  const tasks = new CodexTasks({ token: () => 'local-a' });
  const item = checkpoint('Preserve this compressed task', 'local-a');
  const portable = tasks.transform(item, [], 'local-a', null);
  assert.equal(portable.syncSummary, 'Preserve this compressed task'); assert.equal(portable.encrypted_content, undefined);
  const imported = tasks.transform(portable, [], null, 'local-b');
  assert.equal(expandContext([imported], 'local-b')[0].content[0].text, 'Preserve this compressed task');
});
test('attachments and paths keep a stable history hash after moving to another computer', async t => {
  const root = fixture(t), source = path.join(root, 'source'), destination = path.join(root, 'destination'), attachment = path.join(root, 'picture.png');
  fs.mkdirSync(source); fs.mkdirSync(destination); fs.writeFileSync(attachment, 'fixture image');
  const id = 'task-attachment', timestamp = new Date().toISOString(), file = path.join(root, 'source.jsonl');
  const records = [{ type: 'session_meta', payload: { id, cwd: source, timestamp, runtime_workspace_roots: [root] } },
    { type: 'response_item', payload: { type: 'message', content: [{ type: 'local_image', path: attachment }] } },
    { type: 'response_item', payload: checkpoint('Read ' + source + '/file.txt', 'local-a') }];
  fs.writeFileSync(file, records.map(value => JSON.stringify(value)).join('\n') + '\n');
  const a = new CodexTasks({ token: () => 'local-a' }), b = new CodexTasks({ token: () => 'local-b' });
  const first = a.read({ id, cwd: source, path: file });
  assert.deepEqual(first.records[0].payload.runtime_workspace_roots, ['$PROJECT']);
  assert.equal(first.attachments[0].name, digest(Buffer.from('fixture image')) + '.png');
  const saved = path.join(root, first.attachments[0].name); fs.writeFileSync(saved, Buffer.from(first.attachments[0].data, 'base64'));
  const decoded = b.transform(first.records, [['$PROJECT', destination], ['$ATTACHMENTS', root]], null, 'local-b');
  const next = path.join(root, 'destination.jsonl'); fs.writeFileSync(next, decoded.map(value => JSON.stringify(value)).join('\n') + '\n');
  const second = b.read({ id, cwd: destination, path: next });
  assert.equal(second.hash, first.hash); assert.deepEqual(second.attachments, first.attachments);
  const legacy = structuredClone(decoded);
  legacy[0].payload.runtime_workspace_roots = [process.platform === 'win32' ? '/Users/another-computer/Codex' : 'C:\\Users\\another-computer\\Codex'];
  const broken = path.join(root, 'legacy.jsonl'); fs.writeFileSync(broken, legacy.map(value => JSON.stringify(value)).join('\n') + '\n');
  const repair = b.read({ id, cwd: destination, path: broken });
  assert.equal(repair.hash, first.hash); assert.equal(repair.workspaceRepair, true); assert.notEqual(repair.legacyHash, repair.hash);
  assert.equal(a.transform('C:\\code\\nested\\file.txt', [['C:\\code', '$PROJECT']], null, null), '$PROJECT/nested/file.txt');
  assert.equal(b.transform('{"file":"$PROJECT/nested/file.txt"}', [['$PROJECT', 'D:\\project']], null, null), '{"file":"D:\\\\project/nested/file.txt"}');
});
test('runtime roots from another host or an ancestor are narrowed to the mapped project on Windows and POSIX', () => {
  const record = { type: 'session_meta', payload: { cwd: '$PROJECT', runtime_workspace_roots: ['/Users/example/Documents/Codex', '$PROJECT', '$PROJECT/sub'] } };
  assert.deepEqual(relocateWorkspaceRoots(record, 'D:\\Projects\\task').payload.runtime_workspace_roots, ['D:\\Projects\\task', 'D:\\Projects\\task\\sub']);
  const windows = { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { runtime_workspace_roots: ['C:\\Users\\example', '$PROJECT'] } } };
  assert.deepEqual(relocateWorkspaceRoots(windows, '/home/user/task').payload.thread_settings.runtime_workspace_roots, ['/home/user/task']);
  assert.deepEqual(relocateWorkspaceRoots({ runtimeWorkspaceRoots: [] }, '/home/user/task').runtimeWorkspaceRoots, []);
  assert.deepEqual(relocateWorkspaceRoots({ runtime_workspace_roots: ['$PROJECT/../../elsewhere'] }, 'D:\\Projects\\task').runtime_workspace_roots, ['D:\\Projects\\task']);
  assert.deepEqual(relocateWorkspaceRoots({ runtime_workspace_roots: ['\\\\server\\share\\task\\sub'] }, '\\\\server\\share\\task').runtime_workspace_roots, ['\\\\server\\share\\task\\sub']);
});
test('Windows history repair backs up the rollout and retries a blocked atomic replacement', async t => {
  const home = fixture(t), id = 'repair-task', file = path.join(home, 'rollout.jsonl');
  const meta = { type: 'session_meta', payload: { id, cwd: home, timestamp: new Date().toISOString(), runtime_workspace_roots: [process.platform === 'win32' ? '/Users/old' : 'C:\\old'] } };
  const text = JSON.stringify(meta) + '\n';
  fs.writeFileSync(file, text);
  const tasks = new CodexTasks({ codexHome: home, token: () => 'fixture', platform: 'win32' });
  t.mock.method(tasks, 'withWriter', (_task, _signal, apply) => apply());
  const rename = fs.renameSync;
  let blocked = true, attempts = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === file && blocked) {
      attempts++;
      assert.equal(fs.readFileSync(file, 'utf8'), text);
      throw Object.assign(new Error('Windows denied replacement'), { code: 'EPERM' });
    }
    return rename(from, to);
  });
  await assert.rejects(tasks.repair({ id, path: file, cwd: home }, home, undefined, { workspaceRepair: true }), { code: 'SYNC_FILE_BUSY' });
  assert.ok(attempts > 1);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.equal(fs.readFileSync(path.join(home, 'sync-backups', id + '.jsonl'), 'utf8'), text);
  assert.equal(fs.readdirSync(home).some(name => name.endsWith('.tmp')), false);
  blocked = false;
  await tasks.repair({ id, path: file, cwd: home }, home, undefined, { workspaceRepair: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).payload.runtime_workspace_roots, [home]);
});
test('Windows writer waits for the lock helper and closes its pipe after the protected operation', async t => {
  const home = path.join(fixture(t), "会话's home");
  const launch = (_file, _args, options) => spawn(process.execPath, ['-e', `
    const lines = require('node:readline').createInterface({ input: process.stdin });
    lines.once('line', line => {
      const job = JSON.parse(Buffer.from(line, 'base64'));
      if (job.directory !== process.argv[1] || job.ids.join() !== 'one,two') process.exit(1);
      process.stdout.write('ready\\n');
    });
  `, path.join(home, 'thread-writer-locks')], options);
  const value = await withWindowsWriter(home, ['one', 'two'], undefined, signal => {
    assert.equal(signal.aborted, false);
    return 'protected';
  }, launch);
  assert.equal(value, 'protected');
});
test('Windows lock helper blocks another writer and releases the lock without opening the rollout', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const home = fixture(t), file = path.join(home, 'history.jsonl'), replacement = path.join(home, 'next.jsonl');
  fs.writeFileSync(file, 'old'); fs.writeFileSync(replacement, 'new');
  await withWindowsWriter(home, ['one'], undefined, async () => {
    await assert.rejects(withWindowsWriter(home, ['one'], undefined, () => assert.fail('writer entered')), { code: 'SYNC_BUSY' });
    fs.renameSync(replacement, file);
  });
  await withWindowsWriter(home, ['one'], undefined, () => assert.equal(fs.readFileSync(file, 'utf8'), 'new'));
});
test('sync settings from a second process retain selections and reject concurrent writers', async t => {
  const root = fixture(t), tasks = { list: async () => [{ id: 'task', title: 'Fixture' }] };
  const a = new TaskSync({ root, tasks }), b = new TaskSync({ root, tasks });
  t.after(async () => { await a.close(); await b.close(); });
  await a.list(); await b.list(); await a.select({ id: 'task', enabled: true });
  await b.mapProject({ key: 'a'.repeat(64), directory: root });
  assert.equal(b.load().selected.task.enabled, true);
  await a.exclusive(() => assert.rejects(b.exclusive(async () => {}, 0), error => error.code === 'SYNC_BUSY'));
  assert.equal(fs.existsSync(path.join(root, 'sync.lock')), false);
});
test('invalid incoming paths are rejected before changing the destination project', async t => {
  const root = fixture(t), source = repository(path.join(root, 'source')), target = repository(path.join(root, 'target')), cache = path.join(root, 'cache');
  const project = await projectSnapshot(source, cache), current = await projectSnapshot(target, cache);
  for (const entry of [{ name: '../outside', mode: 0o600, data: Buffer.from('bad').toString('base64') },
    { name: 'link', link: true, mode: 0o777, data: Buffer.from('../outside').toString('base64') }]) {
    await assert.rejects(restoreProject({ ...project, fingerprint: 'changed', files: [entry] }, target, cache, current.fingerprint));
    assert.equal(fs.readFileSync(path.join(target, 'file.txt'), 'utf8'), 'base\n');
    assert.equal(git(target, 'rev-parse', 'HEAD'), current.head);
  }
});
for (const kind of ['git', 'folder']) test(`two computers exchange selected tasks, ${kind} changes and conflict choices over WebDAV`, async t => {
  const root = fixture(t), { config } = await webdavFixture(t), source = path.join(root, 'project-a');
  if (kind === 'folder') { fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'file.txt'), 'base\n'); } else repository(source);
  const local = new Map([['task-1', { id: 'task-1', title: 'Selected task', cwd: source, path: 'fixture' }], ['task-2', { id: 'task-2', title: 'Private task', cwd: source, path: 'fixture' }]]);
  let history = { records: [{ text: 'first message' }], hash: 'history-a', timestamp: new Date().toISOString() };
  const remoteLocal = new Map(); let imported;
  const tasksA = { list: async () => [...local.values()], read: () => history, install: async (_task, value) => { history = value; return 'fixture'; } };
  const tasksB = { list: async () => [...remoteLocal.values()], read: () => imported,
    install: async (task, value, cwd) => { imported = value; remoteLocal.set(task.id, { ...task, cwd, path: 'imported' }); return 'imported'; } };
  const a = new TaskSync({ root: path.join(root, 'a'), tasks: tasksA }), b = new TaskSync({ root: path.join(root, 'b'), tasks: tasksB });
  t.after(async () => { await a.close(); await b.close(); });
  await a.configure(config); await b.configure(config); await a.list(); await a.select({ id: 'task-1', enabled: true });
  await a.run(); assert.equal(a.snapshot().tasks.find(task => task.id === 'task-1').status, 'synced');
  const { tasks: [incoming] } = await b.run(); assert.equal(incoming.title, 'Selected task');
  assert.equal(incoming.status, 'synced', JSON.stringify(b.snapshot()));
  assert.equal(b.snapshot().tasks.some(task => task.id === 'task-2'), false);
  const target = incoming.cwd;
  assert.equal(path.dirname(target), path.join(root, 'fluid-projects'));
  assert.equal(b.load().projects[incoming.projectKey], target);
  assert.equal(imported.hash, 'history-a');

  // An earlier updater could restore the project before failing to replace its history.
  fs.writeFileSync(path.join(source, 'file.txt'), 'updated on A\n');
  history = { ...history, hash: 'next-turn-a' };
  await a.run();
  fs.writeFileSync(path.join(target, 'file.txt'), 'updated on A\n');
  assert.equal((await b.run()).tasks[0].status, 'synced');
  assert.equal(imported.hash, 'next-turn-a');

  // A blocked rollout replacement must still allow the next server revision to apply.
  t.mock.method(tasksB, 'install', async () => { throw Object.assign(new Error('History in use'), { code: 'SYNC_FILE_BUSY' }); });
  fs.writeFileSync(path.join(source, 'file.txt'), 'while blocked\n');
  history = { ...history, hash: 'blocked-turn-a' };
  await a.run(); assert.equal((await b.run()).tasks[0].status, 'waitingFile');
  assert.equal(imported.hash, 'next-turn-a');
  assert.equal(b.load().selected['task-1'].historyHash, 'next-turn-a');
  assert.equal(fs.readFileSync(path.join(target, 'file.txt'), 'utf8'), 'while blocked\n');
  tasksB.install.mock.restore();
  fs.writeFileSync(path.join(source, 'file.txt'), 'newest on A\n');
  history = { ...history, hash: 'newest-turn-a' };
  await a.run(); assert.equal((await b.run()).tasks[0].status, 'synced');
  assert.equal(imported.hash, 'newest-turn-a');
  assert.equal(fs.readFileSync(path.join(target, 'file.txt'), 'utf8'), 'newest on A\n');

  fs.writeFileSync(path.join(target, 'file.txt'), 'continued on B\n'); imported = { ...imported, hash: 'history-b' };
  await b.run(); await a.run(); assert.equal(fs.readFileSync(path.join(source, 'file.txt'), 'utf8'), 'continued on B\n');
  history = { ...history, hash: 'concurrent-a' }; imported = { ...imported, hash: 'concurrent-b' };
  await a.run(); await b.run(); assert.equal(b.snapshot().tasks[0].status, 'conflict');
  assert.equal(imported.hash, 'concurrent-b');
  await b.resolve({ id: 'task-1', choice: 'remote' });
  assert.equal(imported.hash, 'concurrent-a'); assert.equal(b.snapshot().tasks[0].status, 'synced');
  assert.ok(fs.existsSync(path.join(b.cache, 'conflict-task-1.bin')));
  await a.run(); history = { ...history, hash: 'keep-a' }; imported = { ...imported, hash: 'keep-b' };
  await a.run(); await b.run(); assert.equal(b.snapshot().tasks[0].status, 'conflict');
  await b.resolve({ id: 'task-1', choice: 'local' }); await a.run();
  assert.equal(history.hash, 'keep-b'); assert.equal(imported.hash, 'keep-b'); assert.equal(b.snapshot().tasks[0].status, 'synced');
  if (kind === 'git') {
    await b.select({ id: 'task-1', enabled: false });
    assert.equal(b.snapshot().tasks[0].status, 'paused');
    const storage = new SyncStorage(config), journal = new SyncJournal(storage, syncKey(config.passphrase));
    const remote = await journal.read();
    assert.ok(remote.has('task-1'));
    const reviewer = new TaskSync({ root: path.join(root, 'reviewer'), tasks: { list: async () => [] } });
    t.after(() => reviewer.close());
    await reviewer.configure({ ...config, enabled: false });
    const removed = await b.removeRemote({ id: 'task-1' });
    assert.equal(removed.tasks[0].status, 'removed');
    assert.equal(removed.tasks[0].remote, false);
    assert.equal((await journal.read()).has('task-1'), false);
    assert.equal(await storage.get(`objects/${remote.get('task-1').object}.bin`), null);
    assert.equal((await a.run()).tasks.find(task => task.id === 'task-1')?.enabled, false);
    assert.equal(imported.hash, 'keep-b'); assert.equal(history.hash, 'keep-b');
    assert.equal(fs.readFileSync(path.join(target, 'file.txt'), 'utf8'), 'continued on B\n');
    assert.equal((await reviewer.run()).tasks.length, 0);
    await a.select({ id: 'task-1', enabled: true });
    const uploaded = await a.run(); assert.equal(uploaded.tasks.find(task => task.id === 'task-1')?.status, 'synced');
    assert.ok((await journal.read()).has('task-1'));
    assert.equal((await b.run()).tasks[0].enabled, false);
  }
});
test('simultaneous task publishers preserve both heads on WebDAV without conditional writes', { timeout: 15000 }, async t => {
  const root = fixture(t), { config } = await webdavFixture(t), source = repository(path.join(root, 'source'));
  let simultaneous = false, arrived = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const fetchImpl = async (url, options) => {
    if (simultaneous && options.method === 'PUT' && /\/refs\/[a-f0-9]{64}\.bin$/.test(url)) {
      if (++arrived === 2) release(); await barrier;
    }
    return fetch(url, options);
  };
  const left = new Map([['shared', { id: 'shared', title: 'Shared', cwd: source }]]), right = new Map();
  let historyA = { records: [], hash: 'base', timestamp: new Date().toISOString() }, historyB;
  const a = new TaskSync({ root: path.join(root, 'a'), fetchImpl, tasks: { list: async () => [...left.values()], read: () => historyA,
    install: async (_task, value) => { historyA = value; return 'fixture'; } } });
  const b = new TaskSync({ root: path.join(root, 'b'), fetchImpl, tasks: { list: async () => [...right.values()], read: () => historyB,
    install: async (task, value, cwd) => { historyB = value; right.set(task.id, { ...task, cwd }); return 'fixture'; } } });
  t.after(async () => { release(); await a.close(); await b.close(); });
  await a.configure(config); await b.configure(config); await a.list(); await a.select({ id: 'shared', enabled: true }); await a.run();
  const imported = (await b.run()).tasks[0];
  assert.equal(imported?.status, 'synced', imported?.message);
  historyA = { ...historyA, hash: 'left branch' }; historyB = { ...historyB, hash: 'right branch' }; simultaneous = true;
  await Promise.all([a.run(), b.run()]);
  const journal = new SyncJournal(new SyncStorage(config), syncKey(config.passphrase)), ref = (await journal.read()).get('shared');
  assert.equal(arrived, 2); assert.equal(ref.conflict, true); assert.equal(ref.heads.length, 2);
  await a.run(); await b.run();
  assert.equal(a.snapshot().tasks[0].status, 'conflict'); assert.equal(b.snapshot().tasks[0].status, 'conflict');
  assert.equal(historyA.hash, 'left branch'); assert.equal(historyB.hash, 'right branch');
});
test('an upload already in progress cannot resurrect a remotely removed task', { timeout: 15000 }, async t => {
  const root = fixture(t), { config, objects } = await webdavFixture(t), source = path.join(root, 'project');
  fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'file.txt'), 'local project');
  const local = { id: 'shared', title: 'Shared', cwd: source };
  let history = { records: [], hash: 'before', timestamp: new Date().toISOString() };
  let pauseUpload = false, started, release;
  const uploadStarted = new Promise(resolve => { started = resolve; });
  const unblocked = new Promise(resolve => { release = resolve; });
  const writer = new TaskSync({ root: path.join(root, 'writer'), tasks: { list: async () => [local], read: () => history },
    fetchImpl: async (url, options) => {
      if (pauseUpload && options.method === 'PUT' && url.includes('/objects/')) { started(); await unblocked; }
      return fetch(url, options);
    } });
  const remover = new TaskSync({ root: path.join(root, 'remover'), tasks: { list: async () => [] } });
  t.after(async () => { release(); await writer.close(); await remover.close(); });
  await writer.configure(config); await remover.configure(config);
  await writer.select({ id: local.id, enabled: true });
  assert.equal((await writer.run()).tasks[0].status, 'synced');
  history = { ...history, hash: 'during removal' }; pauseUpload = true;
  const uploading = writer.run();
  await uploadStarted;
  try { await remover.removeRemote({ id: local.id }); }
  finally { release(); }
  await uploading;
  const journal = new SyncJournal(new SyncStorage(config), syncKey(config.passphrase));
  assert.equal((await journal.read()).has(local.id), false);
  assert.equal(journal.retired.get(local.id)?.length, 1);
  assert.equal((await writer.run()).tasks[0].status, 'removed');
  assert.deepEqual([...objects.keys()].map(name => path.extname(name)), ['.deleted']);
  assert.equal(fs.readFileSync(path.join(source, 'file.txt'), 'utf8'), 'local project');
  assert.equal(history.hash, 'during removal');
});
test('two selected tasks sharing a project accept the same incoming Git update without a false conflict', async t => {
  const root = fixture(t), { config } = await webdavFixture(t), source = repository(path.join(root, 'shared-a'));
  const make = cwd => {
    const local = new Map(), histories = new Map();
    return { local, histories, tasks: { list: async () => [...local.values()], read: task => histories.get(task.id),
      install: async (task, history, directory) => { histories.set(task.id, history); local.set(task.id, { ...task, cwd: directory, path: 'fixture' }); return 'fixture'; } } };
  };
  const left = make(source), right = make();
  for (const id of ['one', 'two']) { left.local.set(id, { id, title: id, cwd: source, path: 'fixture' }); left.histories.set(id, { records: [], hash: id, timestamp: new Date().toISOString() }); }
  const a = new TaskSync({ root: path.join(root, 'a'), tasks: left.tasks }), b = new TaskSync({ root: path.join(root, 'b'), tasks: right.tasks });
  t.after(async () => { await a.close(); await b.close(); });
  await a.configure(config); await b.configure(config); await a.list();
  for (const id of ['one', 'two']) await a.select({ id, enabled: true });
  const uploaded = await a.run(), target = path.join(root, 'shared-b');
  await b.mapProject({ key: uploaded.tasks[0].projectKey, directory: target });
  const incoming = await b.run();
  assert.ok(incoming.tasks.every(task => task.cwd === target && task.status === 'synced'), JSON.stringify(incoming));
  fs.writeFileSync(path.join(target, 'file.txt'), 'shared update\n'); right.histories.set('one', { ...right.histories.get('one'), hash: 'new turn' });
  await b.run(); await a.run(); const result = await a.run();
  assert.ok(result.tasks.every(task => task.status === 'synced'), JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(source, 'file.txt'), 'utf8'), 'shared update\n');
});
test('automatic mappings share one folder per project and separate independent clones of the same remote', async t => {
  const root = fixture(t), { config } = await webdavFixture(t);
  const first = repository(path.join(root, 'first')), second = repository(path.join(root, 'second'));
  for (const directory of [first, second]) git(directory, 'remote', 'add', 'origin', 'https://example.test/project.git');
  fs.writeFileSync(path.join(second, 'file.txt'), 'second clone\n');
  const tasks = ['one', 'two', 'three'].map(id => ({ id, title: id, cwd: id === 'three' ? second : first }));
  const a = new TaskSync({ root: path.join(root, 'source'), tasks: { list: async () => tasks,
    read: task => ({ records: [], hash: task.id, timestamp: new Date().toISOString() }) } });
  const b = new TaskSync({ root: path.join(root, 'destination'), tasks: { list: async () => [], install: async () => 'fixture' } });
  t.after(async () => { await a.close(); await b.close(); });
  await a.configure(config); await b.configure(config); await a.list();
  for (const { id } of tasks) await a.select({ id, enabled: true });
  await a.run();
  const incoming = await b.run();
  assert.ok(incoming.tasks.every(task => task.status === 'synced'), JSON.stringify(incoming));
  const byID = Object.fromEntries(incoming.tasks.map(task => [task.id, task.cwd]));
  assert.equal(byID.one, byID.two);
  assert.notEqual(byID.one, byID.three);
  assert.equal(fs.readFileSync(path.join(byID.one, 'file.txt'), 'utf8'), 'base\n');
  assert.equal(fs.readFileSync(path.join(byID.three, 'file.txt'), 'utf8'), 'second clone\n');
});
