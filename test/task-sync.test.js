import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { TaskSync } from '../src/task-sync.js';
import { createSyncServer } from '../src/sync-server.js';
import { SyncStorage, syncKey, seal, unseal, digest } from '../src/sync-storage.js';
import { projectSnapshot, restoreProject } from '../src/sync-project.js';
import { CodexTasks } from '../src/sync-codex.js';
import { checkpoint, expandContext } from '../src/compaction.js';

const sqlite = await import('node:sqlite').then(() => true, () => false);
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-switch-sync-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function repository(root) {
  fs.mkdirSync(root, { recursive: true }); git(root, 'init', '-q'); git(root, 'config', 'user.email', 'test@example.test'); git(root, 'config', 'user.name', 'Sync Test');
  fs.writeFileSync(path.join(root, 'file.txt'), 'base\n'); fs.writeFileSync(path.join(root, '.gitignore'), '.env\nignored\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Initial fixture'); return root;
}
async function storage(t, root) {
  const server = await createSyncServer({ database: path.join(root, 'server.sqlite'), token: 'fixture-token-at-least-24-characters' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = { kind: 'server', url: `http://127.0.0.1:${server.address().port}/`, secret: 'fixture-token-at-least-24-characters', passphrase: 'shared fixture encryption password', enabled: true };
  return { config, server };
}
test('WebDAV uses the configured folder and Basic authentication and rejects unsafe conditional writes', async t => {
  const objects = new Map(); let ignoresConditions = false;
  const server = http.createServer(async (req, res) => {
    const reply = (status, data = '', headers = {}) => { res.writeHead(status, headers); res.end(data); };
    if (req.headers.authorization !== 'Basic ' + Buffer.from('user:app-password').toString('base64')) return reply(401);
    if (!req.url.startsWith('/library/easy-switch/')) return reply(404);
    const name = req.url.slice('/library/easy-switch/'.length);
    if (req.method === 'MKCOL') return reply(405);
    if (req.method === 'PROPFIND') return reply(207, '<multistatus xmlns="DAV:">' + [...objects.keys()].map(name => '<response><href>/library/easy-switch/' + name + '</href></response>').join('') + '</multistatus>');
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
  const client = new SyncStorage({ kind: 'webdav', url: `http://127.0.0.1:${server.address().port}/library/easy-switch/`, username: 'user', secret: 'app-password' });
  await client.initialize(); await client.put('refs/selected.bin', Buffer.from('encrypted fixture')); assert.deepEqual(await client.list(), ['selected']);
  assert.equal((await client.get('refs/selected.bin')).data.toString(), 'encrypted fixture');
  ignoresConditions = true; await assert.rejects(client.initialize(), /ignores conditional writes/);
});
test('WebDAV checks existing collections before MKCOL and reads ETags omitted from PUT responses', async t => {
  const root = '/dav/easy-switch/', collections = new Set([root]), objects = new Map(), calls = [];
  const server = http.createServer(async (req, res) => {
    const reply = (status, data = '', headers = {}) => { res.writeHead(status, headers); res.end(data); };
    calls.push([req.method, req.url]);
    assert.match(req.headers['user-agent'], /^easy-switch\//);
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
test('a 403 identifies the failing WebDAV operation without exposing the response or credentials', async () => {
  const base = { kind: 'webdav', url: 'https://dav.example.test/easy-switch/', username: 'private-user', secret: 'private-password' };
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
    reads++; return new Response(seal(ref, key), { headers: { etag: '"stable"' } });
  } });
  t.after(() => sync.close()); sync.config = { ...sync.config, kind: 'webdav', url: 'https://dav.example.test/library/', username: 'user', secret: 'password', passphrase: 'fixture shared passphrase', enabled: true }; sync.save();
  await sync.run(); await sync.run();
  assert.equal(reads, 1); assert.equal(sync.snapshot().tasks[0].status, 'needsProject');
});
test('unconfigured task sync performs no background enumeration or network requests', async t => {
  const root = fixture(t); let calls = 0;
  const sync = new TaskSync({ root, interval: 5, tasks: { list: async () => { calls++; return []; } }, fetchImpl: async () => { calls++; throw Error('Unexpected request'); } });
  sync.start(); await new Promise(resolve => setTimeout(resolve, 30)); await sync.close();
  assert.equal(calls, 0); assert.equal(sync.timer, undefined);
});
test('encrypted WebDAV-compatible objects and SQLite server enforce authentication and conditional writes', { skip: !sqlite }, async t => {
  const root = fixture(t), { config, server } = await storage(t, root), client = new SyncStorage(config);
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
  const traversal = await fetch(config.url + 'other.bin', { headers: { authorization: `Bearer ${config.secret}` } }); assert.equal(traversal.status, 404);
  const port = server.address().port; assert.ok(port);
});
test('Git sync preserves commit, staged and unstaged binary changes, untracked files and ignored local secrets', async t => {
  const root = fixture(t), source = repository(path.join(root, 'source')), cache = path.join(root, 'cache'), target = path.join(root, 'target');
  fs.mkdirSync(cache);
  fs.writeFileSync(path.join(source, 'file.txt'), 'staged\n'); git(source, 'add', 'file.txt');
  fs.appendFileSync(path.join(source, 'file.txt'), 'unstaged\n'); fs.writeFileSync(path.join(source, 'new.bin'), Buffer.from([0, 1, 255]));
  fs.writeFileSync(path.join(source, '.env'), 'SECRET=private');
  const first = await projectSnapshot(source, cache); assert.ok(!JSON.stringify(first.files).includes('SECRET'));
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
  const records = [{ type: 'session_meta', payload: { id, cwd: source, timestamp } },
    { type: 'response_item', payload: { type: 'message', content: [{ type: 'local_image', path: attachment }] } },
    { type: 'response_item', payload: checkpoint('Read ' + source + '/file.txt', 'local-a') }];
  fs.writeFileSync(file, records.map(value => JSON.stringify(value)).join('\n') + '\n');
  const a = new CodexTasks({ token: () => 'local-a' }), b = new CodexTasks({ token: () => 'local-b' });
  const first = a.read({ id, cwd: source, path: file });
  assert.equal(first.attachments[0].name, digest(Buffer.from('fixture image')) + '.png');
  const saved = path.join(root, first.attachments[0].name); fs.writeFileSync(saved, Buffer.from(first.attachments[0].data, 'base64'));
  const decoded = b.transform(first.records, [['$PROJECT', destination], ['$ATTACHMENTS', root]], null, 'local-b');
  const next = path.join(root, 'destination.jsonl'); fs.writeFileSync(next, decoded.map(value => JSON.stringify(value)).join('\n') + '\n');
  const second = b.read({ id, cwd: destination, path: next });
  assert.equal(second.hash, first.hash); assert.deepEqual(second.attachments, first.attachments);
  assert.equal(a.transform('C:\\code\\nested\\file.txt', [['C:\\code', '$PROJECT']], null, null), '$PROJECT/nested/file.txt');
  assert.equal(b.transform('{"file":"$PROJECT/nested/file.txt"}', [['$PROJECT', 'D:\\project']], null, null), '{"file":"D:\\\\project/nested/file.txt"}');
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
test('two computers automatically exchange only selected tasks, continue Git changes and preserve simultaneous edits', { skip: !sqlite }, async t => {
  const root = fixture(t), { config } = await storage(t, root), source = repository(path.join(root, 'project-a'));
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
  await b.run(); const incoming = b.snapshot().tasks[0]; assert.equal(incoming.title, 'Selected task'); assert.equal(incoming.status, 'needsProject');
  assert.equal(b.snapshot().tasks.some(task => task.id === 'task-2'), false);
  const target = path.join(root, 'project-b'); await b.mapProject({ key: incoming.projectKey, directory: target }); await b.run();
  assert.equal(b.snapshot().tasks[0].status, 'synced', JSON.stringify(b.snapshot())); assert.equal(imported.hash, 'history-a');
  fs.writeFileSync(path.join(target, 'file.txt'), 'continued on B\n'); imported = { ...imported, hash: 'history-b' };
  await b.run(); await a.run(); assert.equal(fs.readFileSync(path.join(source, 'file.txt'), 'utf8'), 'continued on B\n');
  history = { ...history, hash: 'concurrent-a' }; imported = { ...imported, hash: 'concurrent-b' };
  await a.run(); await b.run(); assert.equal(b.snapshot().tasks[0].status, 'conflict');
  assert.equal(imported.hash, 'concurrent-b');
  await b.resolve({ id: 'task-1', choice: 'remote' });
  assert.equal(imported.hash, 'concurrent-a'); assert.equal(b.snapshot().tasks[0].status, 'synced');
  assert.ok(fs.existsSync(path.join(b.cache, 'conflict-task-1.bin')));
});
test('two selected tasks sharing a project accept the same incoming Git update without a false conflict', { skip: !sqlite }, async t => {
  const root = fixture(t), { config } = await storage(t, root), source = repository(path.join(root, 'shared-a'));
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
  await a.run(); const pending = await b.run(), target = path.join(root, 'shared-b');
  await b.mapProject({ key: pending.tasks[0].projectKey, directory: target }); await b.run();
  fs.writeFileSync(path.join(target, 'file.txt'), 'shared update\n'); right.histories.set('one', { ...right.histories.get('one'), hash: 'new turn' });
  await b.run(); await a.run(); const result = await a.run();
  assert.ok(result.tasks.every(task => task.status === 'synced'), JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(source, 'file.txt'), 'utf8'), 'shared update\n');
});
