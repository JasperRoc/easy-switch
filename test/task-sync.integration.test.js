import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { TaskSync } from '../src/task-sync.js';
import { createSyncServer } from '../src/sync-server.js';
import { CodexTasks, codexSession } from '../src/sync-codex.js';
import { init, atomic } from '../src/store.js';

const binary = process.env.SWITCH_TEST_CODEX;
const sqlite = await import('node:sqlite').then(() => true, () => false);
for (const kind of ['git', 'folder']) test(`real Codex selected task and ${kind} files move between two homes and resume with the same history and task ID`, { skip: !binary || !sqlite, timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-switch-real-sync-'));
  const project = path.join(dir, 'project-a'); fs.mkdirSync(project);
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' }).trim();
  if (kind === 'git') {
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
    fs.writeFileSync(path.join(project, 'file.txt'), 'committed\n'); git('add', '.'); git('commit', '-qm', 'Fixture');
  }
  fs.writeFileSync(path.join(project, 'file.txt'), 'uncommitted on A\n');
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const input = JSON.parse(Buffer.concat(chunks)); requests.push(input);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const item = { type: 'message', id: 'msg_' + requests.length, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'SYNC_OK', annotations: [] }] };
    for (const event of [{ type: 'response.created', response: { id: 'resp_sync', output: [] } }, { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'resp_sync', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]) res.write('data: ' + JSON.stringify(event) + '\n\n');
    res.end();
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const roots = ['a', 'b'].map(name => ({ root: path.join(dir, name, 'switch'), home: path.join(dir, name, 'codex') }));
  for (const entry of roots) {
    init(entry.root); fs.mkdirSync(entry.home, { recursive: true });
    fs.writeFileSync(path.join(entry.home, 'config.toml'), `model_provider="fixture"\nmodel="gpt-6.1-sol"\n[model_providers.fixture]\nname="Fixture"\nbase_url="http://127.0.0.1:${upstream.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
  }
  const server = await createSyncServer({ database: path.join(dir, 'sync.sqlite'), token: 'fixture-shared-token-at-least-24' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const config = { kind: 'server', url: `http://127.0.0.1:${server.address().port}/`, secret: 'fixture-shared-token-at-least-24', passphrase: 'fixture shared encryption passphrase', enabled: true };
  const [a, b] = roots.map(entry => new TaskSync({ root: entry.root, codexHome: entry.home, binary }));
  t.after(async () => { await a.close(); await b.close(); server.closeAllConnections(); server.close(); upstream.closeAllConnections(); upstream.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const first = await codexSession({ binary, codexHome: roots[0].home }, async call => {
    const { thread } = await call('thread/start', { cwd: project, runtimeWorkspaceRoots: [dir], approvalPolicy: 'never', sandbox: 'read-only' });
    await call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Remember the first computer', text_elements: [] }] });
    for (let i = 0; i < 100; i++) {
      const result = await call('thread/read', { threadId: thread.id, includeTurns: true }).catch(() => null);
      if (result?.thread.turns.at(-1)?.status === 'completed') return thread;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Fixture turn did not finish.');
  });
  await a.configure(config); await a.list(); await a.select({ id: first.id, enabled: true });
  const uploaded = await a.run(); assert.equal(uploaded.tasks[0].status, 'synced', JSON.stringify(uploaded));
  await b.configure(config); const incoming = await b.run(); assert.equal(incoming.tasks[0].status, 'needsProject');
  const destination = path.join(dir, 'project-b'); await b.mapProject({ key: incoming.tasks[0].projectKey, directory: destination });
  const downloaded = await b.run(); assert.equal(downloaded.tasks[0].status, 'synced', JSON.stringify(downloaded));
  assert.equal(fs.readFileSync(path.join(destination, 'file.txt'), 'utf8'), 'uncommitted on A\n');
  const tasksB = new CodexTasks({ binary, codexHome: roots[1].home, token: () => init(roots[1].root).token });
  assert.ok((await tasksB.list()).some(task => task.id === first.id));
  const imported = (await tasksB.list()).find(task => task.id === first.id);
  const importedMeta = JSON.parse(fs.readFileSync(imported.path, 'utf8').split('\n')[0]);
  if (importedMeta.payload.runtime_workspace_roots) assert.deepEqual(importedMeta.payload.runtime_workspace_roots, [destination]);
  // Reproduce an already-imported foreign workspace root even when content is otherwise unchanged.
  const damaged = fs.readFileSync(imported.path, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  damaged[0].payload.runtime_workspace_roots = ['C:\\Users\\other-computer\\Codex'];
  fs.writeFileSync(imported.path, damaged.map(record => JSON.stringify(record)).join('\n') + '\n');
  const legacy = tasksB.read(imported, destination), saved = b.load();
  saved.selected[first.id].historyHash = legacy.legacyHash;
  atomic(b.file, saved);
  await codexSession({ binary, codexHome: roots[1].home }, async call => {
    await call('thread/resume', { threadId: first.id, cwd: destination, runtimeWorkspaceRoots: [destination], excludeTurns: true });
    const waiting = await b.run(); assert.equal(waiting.tasks[0].status, 'opened', JSON.stringify(waiting));
  });
  const repaired = await b.run(); assert.equal(repaired.tasks[0].status, 'synced', JSON.stringify(repaired));
  const afterRepair = JSON.parse(fs.readFileSync(imported.path, 'utf8').split('\n')[0]);
  assert.deepEqual(afterRepair.payload.runtime_workspace_roots.map(root => fs.realpathSync(root)), [fs.realpathSync(destination)]);
  assert.ok(fs.existsSync(path.join(roots[1].home, 'sync-backups', first.id + '.jsonl')));
  await codexSession({ binary, codexHome: roots[1].home }, async call => {
    const resumed = await call('thread/resume', { threadId: first.id, excludeTurns: true }); assert.equal(resumed.thread.id, first.id);
    await call('turn/start', { threadId: first.id, input: [{ type: 'text', text: 'Continue on the second computer', text_elements: [] }] });
    for (let i = 0; i < 100; i++) {
      const result = await call('thread/read', { threadId: first.id, includeTurns: true });
      if (result.thread.turns.length === 2 && result.thread.turns.at(-1).status === 'completed') return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Imported turn did not finish.');
  });
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
    const read = await call('thread/read', { threadId: first.id, includeTurns: true }); assert.equal(read.thread.turns.length, 2);
  });
  for (let pass = 0; pass < 3; pass++) {
    const stableA = await a.run(), stableB = await b.run();
    assert.equal(stableA.tasks[0].status, 'synced', JSON.stringify(stableA));
    assert.equal(stableB.tasks[0].status, 'synced', JSON.stringify(stableB));
  }
});
