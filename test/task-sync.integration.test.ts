import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { TaskSync } from '../src/task-sync.js';
import { webdavFixture } from './fixtures/webdav.js';
import { SshSyncStorage, sshDestination } from '../src/sync-ssh.js';
import { SyncJournal } from '../src/sync-journal.js';
import { syncKey } from '../src/sync-storage.js';
import { CodexTasks, codexSession } from '../src/sync-codex.js';
import { addProvider, init, atomic } from '../src/store.js';
import { patchedConfig } from '../src/install.js';
import { createProxy } from './reference/proxy.js';

const binary = process.env.SWITCH_TEST_CODEX;
const { DatabaseSync } = await import('node:sqlite').catch(() => ({}));
const sshHost = process.env.SWITCH_TEST_SFTP_HOST;
test('SSH sync accepts aliases and user addresses while rejecting shell syntax, options and remote paths', async () => {
  assert.equal(sshDestination(' cxl3 '), 'cxl3');
  assert.equal(sshDestination('alice@example.test'), 'alice@example.test');
  for (const input of ['', '-oProxyCommand=x', 'a;date', 'ssh a', 'a@-b', 'ssh://example.test', 'example.test:/tmp', 'host\nquit']) {
    assert.throws(() => sshDestination(input), /SSH alias/);
  }
  const storage = new SshSyncStorage('fixture');
  await assert.rejects(storage.get('objects/../secret.bin'), /Invalid sync object path/);
  await assert.rejects(storage.putImmutable('refs/' + '0'.repeat(64) + '.bin', Buffer.from('fixture')), /filename does not match/);
});
test('SFTP verifies server identity and rejects an unauthorized key', { skip: !process.env.SWITCH_TEST_SFTP_UNTRUSTED || !process.env.SWITCH_TEST_SFTP_UNAUTHORIZED, timeout: 10000 }, async () => {
  await assert.rejects(new SshSyncStorage(process.env.SWITCH_TEST_SFTP_UNTRUSTED).initialize(), /Verify the SSH host/);
  await assert.rejects(new SshSyncStorage(process.env.SWITCH_TEST_SFTP_UNAUTHORIZED).initialize(), /SSH sign-in failed/);
});
for (const [kind, transport] of [['git', 'webdav'], ['folder', 'webdav'], ['git', 'ssh']]) test(
  `real Codex syncs a ${kind} task over ${transport} and resumes the same thread through the destination route`,
  { skip: !binary || !DatabaseSync || transport === 'ssh' && !sshHost, timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluid-real-sync-'));
  const project = path.join(dir, 'project-a'); fs.mkdirSync(project);
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' }).trim();
  if (kind === 'git') {
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
    fs.writeFileSync(path.join(project, 'file.txt'), 'committed\n'); git('add', '.'); git('commit', '-qm', 'Fixture');
  }
  const cwd = kind === 'git' ? path.join(project, 'empty-subdirectory') : project;
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(project, 'file.txt'), 'uncommitted on A\n');
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-6.1-sol' }] }));
    }
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const input = JSON.parse(Buffer.concat(chunks)); requests.push({ ...input, authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const item = { type: 'message', id: 'msg_' + requests.length, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'SYNC_OK', annotations: [] }] };
    for (const event of [{ type: 'response.created', response: { id: 'resp_sync', output: [] } }, { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'resp_sync', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]) res.write('data: ' + JSON.stringify(event) + '\n\n');
    res.end();
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const roots = ['a', 'b'].map(name => ({ root: path.join(dir, name, 'switch'), home: path.join(dir, name, 'codex') }));
  const destinationIndex = path.join(dir, 'b', 'index');
  const upstreamURL = `http://127.0.0.1:${upstream.address().port}/v1`;
  const route = createProxy({ root: roots[1].root });
  route.listen(0, '127.0.0.1'); await once(route, 'listening');
  const base = `model="gpt-6.1-sol"\nopenai_base_url="${upstreamURL}"\nchatgpt_base_url="${upstreamURL}"\ncli_auth_credentials_store="file"\n[analytics]\nenabled=false\n`;
  for (const [index, entry] of roots.entries()) {
    init(entry.root); fs.mkdirSync(entry.home, { recursive: true });
    // Generate the original turn with a local relay. No auth or model requests leave the fixture.
    const indexDirectory = index === 1 ? destinationIndex : entry.home;
    let configuration = `sqlite_home=${JSON.stringify(indexDirectory)}\n${base}`;
    if (index === 0 || kind === 'folder') configuration = 'model_provider="source_only"\n' + configuration +
      `\n[model_providers.source_only]\nname="Source relay"\nbase_url="${upstreamURL}"\nwire_api="responses"\n`;
    fs.writeFileSync(path.join(entry.home, 'config.toml'), configuration);
  }
  const destinationKey = 'destination-fixture-key';
  addProvider('destination', { type: 'api', baseUrl: upstreamURL, apiKey: destinationKey }, roots[1].root);
  const enableDestinationRoute = () => fs.writeFileSync(path.join(roots[1].home, 'config.toml'), patchedConfig(
    `sqlite_home=${JSON.stringify(destinationIndex)}\n${base}`, route.address().port, init(roots[1].root).token));
  if (kind === 'git') enableDestinationRoute();
  const config = transport === 'ssh' ? { kind: 'ssh', url: sshHost,
    passphrase: 'fixture shared encryption passphrase', enabled: true } : (await webdavFixture(t)).config;
  const [a, b] = roots.map(entry => new TaskSync({ root: entry.root, codexHome: entry.home, binary }));
  t.after(async () => { await a.close(); await b.close(); route.closeAllConnections(); route.close(); upstream.closeAllConnections(); upstream.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const first = await codexSession({ binary, codexHome: roots[0].home }, async call => {
    const { thread } = await call('thread/start', { cwd, runtimeWorkspaceRoots: [dir], approvalPolicy: 'never', sandbox: 'read-only' });
    await call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Remember the first computer', text_elements: [] }] });
    for (let i = 0; i < 100; i++) {
      const result = await call('thread/read', { threadId: thread.id, includeTurns: true }).catch(() => null);
      if (result?.thread.turns.at(-1)?.status === 'completed') return result.thread;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Fixture turn did not finish.');
  });
  await a.configure(config); await a.list(); await a.select({ id: first.id, enabled: true });
  const uploaded = await a.run(); assert.equal(uploaded.tasks[0].status, 'synced', JSON.stringify(uploaded));
  if (transport === 'ssh') {
    assert.equal(await new SshSyncStorage(config.url).get('objects/not_present.bin'), null);
    await assert.rejects(b.configure({ ...config, passphrase: 'incorrect fixture passphrase' }), /Unable to decrypt sync data/);
    assert.equal(b.snapshot().configured, false);
  }
  await b.configure({ ...config, ...(transport === 'ssh' && process.env.SWITCH_TEST_SFTP_PEER ? { url: process.env.SWITCH_TEST_SFTP_PEER } : {}) });
  const downloaded = await b.run(); assert.equal(downloaded.tasks[0].status, 'synced', JSON.stringify(downloaded));
  const [{ projectKey, cwd: destination }] = downloaded.tasks;
  const destinationRoot = path.join(dir, 'b', 'fluid-projects', projectKey);
  assert.equal(downloaded.projects[projectKey], destinationRoot);
  assert.equal(destination, path.join(destinationRoot, path.relative(project, cwd)));
  assert.ok(fs.statSync(destination).isDirectory());
  assert.equal(fs.readFileSync(path.join(destinationRoot, 'file.txt'), 'utf8'), 'uncommitted on A\n');
  const tasksB = new CodexTasks({ binary, codexHome: roots[1].home, token: () => init(roots[1].root).token });
  assert.ok((await tasksB.list()).some(task => task.id === first.id));
  const imported = (await tasksB.list()).find(task => task.id === first.id);
  const importedMeta = JSON.parse(fs.readFileSync(imported.path, 'utf8').split('\n')[0]);
  assert.equal(importedMeta.payload.model_provider, kind === 'git' ? 'fluid' : 'source_only');
  if (importedMeta.payload.runtime_workspace_roots) assert.deepEqual(importedMeta.payload.runtime_workspace_roots.map(root => fs.realpathSync(root)), [fs.realpathSync(destinationRoot)]);
  const records = fs.readFileSync(imported.path, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  if (kind === 'git') {
    // Exercise workspace repair alongside the new import.
    records[0].payload.runtime_workspace_roots = [process.platform === 'win32' ? '/Users/other-computer/Codex' : 'C:\\Users\\other-computer\\Codex'];
  } else {
    // Seed the legacy copy that would send an unauthenticated request to OpenAI.
    records[0].payload.model_provider = 'openai';
    for (const record of records) if (record.payload?.type === 'thread_settings_applied' && record.payload.thread_id === first.id) {
      record.payload.thread_settings.model_provider_id = 'openai';
    }
    const db = new DatabaseSync(path.join(destinationIndex, 'state_5.sqlite'));
    try {
      assert.equal(db.prepare('SELECT history_mode FROM threads WHERE id = ?').get(first.id).history_mode, 'paginated');
      assert.equal(db.prepare("UPDATE threads SET model_provider = 'openai' WHERE id = ?").run(first.id).changes, 1);
    } finally { db.close(); }
    enableDestinationRoute();
  }
  fs.writeFileSync(imported.path, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const legacy = tasksB.read(imported, destinationRoot), saved = b.load();
  saved.selected[first.id].historyHash = legacy.legacyHash;
  atomic(b.file, saved);
  await codexSession({ binary, codexHome: roots[1].home }, async call => {
    const opened = await call('thread/resume', { threadId: first.id, excludeTurns: true,
      ...(kind === 'git' ? { cwd: destination, runtimeWorkspaceRoots: [destinationRoot] } : {}) });
    assert.equal(opened.modelProvider, kind === 'git' ? 'fluid' : 'openai');
    const waiting = await b.run(); assert.equal(waiting.tasks[0].status, 'opened', JSON.stringify(waiting));
  });
  if (kind === 'folder') {
    const indexing = t.mock.method(b.tasks, 'index', async () => { throw new Error('Interrupted index update'); });
    const interrupted = await b.run();
    assert.equal(interrupted.tasks[0].status, 'error', JSON.stringify(interrupted));
    assert.equal(b.load().selected[first.id].providerRepair, true);
    assert.equal(JSON.parse(fs.readFileSync(imported.path, 'utf8').split('\n')[0]).payload.model_provider, 'fluid');
    indexing.mock.restore();
  }
  const repaired = await b.run(); assert.equal(repaired.tasks[0].status, 'synced', JSON.stringify(repaired));
  const afterRepair = JSON.parse(fs.readFileSync(imported.path, 'utf8').split('\n')[0]);
  assert.deepEqual(afterRepair.payload.runtime_workspace_roots.map(root => fs.realpathSync(root)), [fs.realpathSync(destinationRoot)]);
  assert.ok(fs.existsSync(path.join(roots[1].home, 'sync-backups', first.id + '.jsonl')));
  assert.equal(afterRepair.payload.model_provider, 'fluid');
  if (kind === 'folder') {
    const selected = b.load().selected[first.id];
    assert.equal(selected.providerRepair, undefined);
    assert.equal(selected.revision, a.load().selected[first.id].revision, 'local provider repair must not publish a competing revision');
  }
  await codexSession({ binary, codexHome: roots[1].home }, async call => {
    const resumed = await call('thread/resume', { threadId: first.id, excludeTurns: true }); assert.equal(resumed.thread.id, first.id);
    assert.equal(fs.realpathSync(resumed.thread.cwd), fs.realpathSync(destination));
    assert.equal(resumed.modelProvider, 'fluid');
    await call('turn/start', { threadId: first.id, input: [{ type: 'text', text: 'Continue on the second computer', text_elements: [] }] });
    for (let i = 0; i < 100; i++) {
      const result = await call('thread/read', { threadId: first.id, includeTurns: true });
      if (result.thread.turns.length === 2 && result.thread.turns.at(-1).status === 'completed') return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Imported turn did not finish.');
  });
  assert.equal(requests.at(-1).authorization, 'Bearer ' + destinationKey);
  assert.match(JSON.stringify(requests.at(-1).input), /Remember the first computer/);
  assert.match(JSON.stringify(requests.at(-1).input), /Continue on the second computer/);
  const updated = await b.run(); assert.equal(updated.tasks[0].status, 'synced', JSON.stringify(updated));
  await codexSession({ binary, codexHome: roots[0].home }, async call => {
    await call('thread/resume', { threadId: first.id, excludeTurns: true });
    const waiting = await a.run(); assert.equal(waiting.tasks[0].status, 'opened', JSON.stringify(waiting));
    const read = await call('thread/read', { threadId: first.id, includeTurns: true }); assert.equal(read.thread.turns.length, 1, 'an open writer must never be overwritten');
  });
  const back = await a.run(); assert.equal(back.tasks[0].status, 'synced', JSON.stringify(back));
  await codexSession({ binary, codexHome: roots[0].home }, async call => {
    const resumed = await call('thread/resume', { threadId: first.id, excludeTurns: true }); assert.equal(resumed.thread.id, first.id);
    assert.equal(resumed.modelProvider, 'source_only');
    const read = await call('thread/read', { threadId: first.id, includeTurns: true }); assert.equal(read.thread.turns.length, 2);
  });
  for (let pass = 0; pass < 3; pass++) {
    const stableA = await a.run(), stableB = await b.run();
    assert.equal(stableA.tasks[0].status, 'synced', JSON.stringify(stableA));
    assert.equal(stableB.tasks[0].status, 'synced', JSON.stringify(stableB));
  }
  if (kind !== 'git') return;
  b.start(); await b.run(); // Exercise the cached task metadata used in the background.
  const beforeArchive = b.load().selected[first.id].revision;
  assert.equal(beforeArchive, a.load().selected[first.id].revision);
  const query = (home, archived) => codexSession({ binary, codexHome: home }, call =>
    call('thread/list', { archived, modelProviders: [] })).then(result => result.data.filter(thread => thread.id === first.id));
  await codexSession({ binary, codexHome: roots[1].home }, call => call('thread/archive', { threadId: first.id }));
  const originalList = b.tasks.list.bind(b.tasks);
  const missed = t.mock.method(b.tasks, 'list', async signal => (await originalList(signal)).filter(task => task.id !== first.id));
  const archived = await b.run();
  missed.mock.restore();
  assert.equal(archived.tasks.find(task => task.id === first.id)?.archived, true, JSON.stringify(archived));
  assert.equal(archived.tasks.find(task => task.id === first.id)?.status, 'synced');
  assert.equal((await query(roots[1].home, false)).length, 0);
  const [archivedThread] = await query(roots[1].home, true);
  assert.ok(archivedThread.path);
  assert.equal((await query(roots[0].home, false)).length, 1);
  assert.equal(b.load().selected[first.id].revision, beforeArchive, 'archive state must not publish a history revision');
  fs.writeFileSync(path.join(project, 'file.txt'), 'updated on A after archive\n');
  assert.equal((await a.run()).tasks.find(task => task.id === first.id)?.status, 'synced');
  const refreshed = await b.run();
  assert.equal(refreshed.tasks.find(task => task.id === first.id)?.status, 'synced', JSON.stringify(refreshed));
  assert.equal(refreshed.tasks.find(task => task.id === first.id)?.archived, true);
  assert.equal((await query(roots[1].home, true))[0]?.path, archivedThread.path);
  assert.equal((await query(roots[1].home, false)).length, 0);
  assert.equal(fs.readFileSync(path.join(destinationRoot, 'file.txt'), 'utf8'), 'updated on A after archive\n');
  await codexSession({ binary, codexHome: roots[1].home }, call => call('thread/unarchive', { threadId: first.id }));
  const restored = await b.run();
  assert.equal(restored.tasks.find(task => task.id === first.id)?.archived, false);
  assert.equal((await query(roots[1].home, false)).length, 1);
  if (transport === 'ssh') {
    await b.close();
    assert.equal((await a.run()).tasks.find(task => task.id === first.id)?.status, 'synced');
    assert.equal(b.load().selected[first.id].revision, a.load().selected[first.id].revision);
    fs.writeFileSync(path.join(project, 'file.txt'), 'changed on A\n');
    fs.writeFileSync(path.join(destinationRoot, 'file.txt'), 'changed on B\n');
    const published = await a.run();
    assert.equal(published.tasks.find(task => task.id === first.id)?.status, 'synced', JSON.stringify(published));
    const conflict = await b.run();
    assert.equal(conflict.tasks.find(task => task.id === first.id)?.status, 'conflict', JSON.stringify(conflict));
    assert.equal(fs.readFileSync(path.join(destinationRoot, 'file.txt'), 'utf8'), 'changed on B\n');
    assert.equal(fs.readFileSync(path.join(project, 'file.txt'), 'utf8'), 'changed on A\n');
    const storage = new SshSyncStorage(sshHost), journal = new SyncJournal(storage, syncKey(config.passphrase));
    const before = (await journal.read()).get(first.id);
    const removed = await b.removeRemote({ id: first.id });
    assert.equal(removed.tasks[0].status, 'removed');
    assert.equal((await journal.read()).has(first.id), false);
    const object = `objects/${before.object}.bin`;
    assert.equal(await storage.get(object), null);
    await storage.removeFiles([object]);
    assert.equal((await a.run()).tasks[0].status, 'removed');
    assert.equal((await query(roots[1].home, false)).length, 1);
  }
});
