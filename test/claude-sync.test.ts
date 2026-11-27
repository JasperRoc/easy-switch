import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { TaskSync, SessionSync } from '../src/task-sync.js';
import { ClaudeTasks, claudeProjectKey } from '../src/sync-claude.js';
import { webdavFixture } from './fixtures/webdav.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fluid-claude-sync-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory;
}
function history(home, project, id = randomUUID()) {
  const folder = path.join(home, 'projects', claudeProjectKey(project)); fs.mkdirSync(folder, { recursive: true });
  const records = [
    { type: 'user', sessionId: id, cwd: project, uuid: randomUUID(), parentUuid: null, timestamp: '2026-11-25T10:00:00Z', message: { role: 'user', content: 'Remember the original computer' } },
    { type: 'assistant', sessionId: id, cwd: project, uuid: randomUUID(), parentUuid: null, timestamp: '2026-11-25T10:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Remembered' }], stop_reason: 'end_turn' } },
    { type: 'custom-title', sessionId: id, customTitle: 'Cross-device Claude task' },
    { type: 'bridge-session', sessionId: id, ownerAccountUuid: 'private-account', bridgeSessionId: 'old-remote' },
  ];
  records[1].parentUuid = records[0].uuid;
  const file = path.join(folder, id + '.jsonl'); fs.writeFileSync(file, records.map(value => JSON.stringify(value)).join('\n') + '\n');
  const old = new Date(Date.now() - 5000); fs.utimesSync(file, old, old);
  return { id, file, records };
}
test('Claude transcript adapter relocates projects, preserves agent history and excludes host bridge identity', async t => {
  const dir = fixture(t), home = path.join(dir, 'claude'), project = path.join(dir, 'project'); fs.mkdirSync(project);
  const source = history(home, project), tasks = new ClaudeTasks({ claudeHome: home });
  const agent = path.join(path.dirname(source.file), source.id, 'subagents', 'agent-fixture.jsonl'); fs.mkdirSync(path.dirname(agent), { recursive: true });
  fs.writeFileSync(agent, JSON.stringify({ type: 'assistant', sessionId: source.id, cwd: project, message: { content: [{ type: 'text', text: 'Agent history' }] } }) + '\n');
  const old = new Date(Date.now() - 5000); fs.utimesSync(agent, old, old);
  const [task] = await tasks.list(); assert.equal(task.title, 'Cross-device Claude task');
  const pack = tasks.read(task, project); assert.ok(pack); assert.doesNotMatch(JSON.stringify(pack), /private-account|old-remote/); assert.match(JSON.stringify(pack), /\$PROJECT/);
  assert.equal(pack.sessionFiles.length, 1);
  const destination = path.join(dir, 'destination'), newHome = path.join(dir, 'other-claude'); fs.mkdirSync(destination);
  const other = new ClaudeTasks({ claudeHome: newHome });
  const file = await other.install(task, pack, destination, undefined, new AbortController().signal);
  const imported = (await other.list())[0]; assert.equal(imported.id, task.id); assert.equal(imported.cwd, destination);
  assert.equal(other.read(imported).hash, pack.hash); assert.ok(fs.existsSync(path.join(path.dirname(file), task.id, 'subagents', 'agent-fixture.jsonl')));
  fs.appendFileSync(source.file, JSON.stringify({ type: 'user', sessionId: task.id, message: { role: 'user', content: 'Working' } }) + '\n');
  assert.equal(tasks.read(task), null);
  await assert.rejects(other.install({ ...task, id: '../escape' }, pack, destination, undefined, new AbortController().signal), /Invalid/);
});
test('incoming Claude revisions wait for a live client session and ignore stale process records', async t => {
  const root = fixture(t), home = path.join(root, 'claude'), sessions = path.join(home, 'sessions'), id = randomUUID(); fs.mkdirSync(sessions, { recursive: true });
  const tasks = new ClaudeTasks({ claudeHome: home }), file = path.join(sessions, process.pid + '.json');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId: id }));
  let applied = false;
  await assert.rejects(tasks.withWriter({ id }, new AbortController().signal, () => { applied = true; }), error => error.code === 'SYNC_BUSY');
  assert.equal(applied, false);
  fs.writeFileSync(file, JSON.stringify({ pid: 2147483647, sessionId: id }));
  await tasks.withWriter({ id }, new AbortController().signal, () => { applied = true; }); assert.equal(applied, true);
});
test('both clients share saved credentials but keep selections, projects, journals and removals isolated', async t => {
  const dir = fixture(t), { config, objects } = await webdavFixture(t), project = path.join(dir, 'project'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'file.txt'), 'uncommitted content');
  const home = path.join(dir, 'claude-a'), source = history(home, project), root = path.join(dir, 'a', 'switch');
  const a = new TaskSync({ root, client: 'claude', claudeHome: home }), b = new TaskSync({ root: path.join(dir, 'b', 'switch'), client: 'claude', claudeHome: path.join(dir, 'claude-b') });
  t.after(async () => { await a.close(); await b.close(); });
  await a.configure(config); await a.list(); await a.select({ id: source.id, enabled: true });
  const uploaded = await a.run(); assert.equal(uploaded.tasks[0].status, 'synced', JSON.stringify(uploaded));
  const saved = JSON.parse(fs.readFileSync(a.file)); assert.equal(saved.selected[source.id], undefined); assert.equal(saved.claude.selected[source.id].enabled, true);
  assert.ok([...objects.keys()].some(name => /\/claude\/refs\//.test(name)));
  await b.configure(config); const imported = await b.run(); assert.equal(imported.tasks[0].status, 'synced', JSON.stringify(imported));
  assert.equal(fs.readFileSync(path.join(imported.tasks[0].cwd, 'file.txt'), 'utf8'), 'uncommitted content');
  const codex = new TaskSync({ root, tasks: { list: async () => [] } }); t.after(() => codex.close());
  codex.config.selected['codex-only'] = { enabled: false }; codex.save();
  assert.equal(a.load().selected[source.id].enabled, true); assert.equal(codex.load().selected['codex-only'].enabled, false);
  await a.removeRemote({ id: source.id }); assert.equal((await b.run()).tasks[0].status, 'removed');
  assert.ok(fs.existsSync(imported.tasks[0].path || (await b.tasks.list())[0].path), 'remote removal preserves the local transcript');
  assert.equal(codex.load().selected['codex-only'].enabled, false);
  const sync = new SessionSync({ root, claudeHome: home, codexHome: path.join(dir, 'codex'), tasks: { list: async () => [] } }); t.after(() => sync.close());
  assert.equal((await sync.setClient('claude')).client, 'claude'); assert.equal(sync.snapshot().configured, true);
  assert.equal((await sync.setClient('codex')).client, 'codex'); assert.equal(sync.snapshot().tasks.length, 0);
});
test('shared scheduler avoids an unused Codex executable and serializes repeated sync requests', async t => {
  const dir = fixture(t), { config } = await webdavFixture(t);
  const sync = new SessionSync({ root: path.join(dir, 'switch'), claudeHome: path.join(dir, 'claude'), codexHome: path.join(dir, 'codex'),
    tasks: { list: async () => { throw new Error('Codex is not installed'); } } });
  t.after(() => sync.close());
  await sync.setClient('claude'); await sync.configure(config);
  let cycles = 0;
  const cycle = sync.clients.claude.cycle.bind(sync.clients.claude);
  sync.clients.claude.cycle = async signal => { cycles++; return cycle(signal); };
  const first = sync.run(); assert.equal(sync.run(), first);
  const result = await first;
  assert.equal(cycles, 1); assert.equal(result.error, ''); assert.equal(sync.clients.codex.error, '');
});
test('manual sync starts with the displayed client before processing the other client', async t => {
  const root = fixture(t), sync = new SessionSync({ root, tasks: { list: async () => [] }, managedSchedule: true });
  t.after(() => sync.close()); const calls = [];
  for (const client of ['codex', 'claude']) sync.clients[client].run = async () => { calls.push(client); return sync.clients[client].snapshot(); };
  sync.client = 'claude'; await sync.run(); assert.deepEqual(calls, ['claude', 'codex']);
});
const binary = process.env.SWITCH_TEST_CLAUDE;
test('official Claude Code resumes a synchronized session with the original conversation and local routing', { skip: !binary, timeout: 45000 }, async t => {
  const dir = fixture(t), calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    let body; try { body = JSON.parse(Buffer.concat(chunks)); } catch { res.writeHead(200).end('{}'); return; }
    calls.push(body);
    const events = [
      { type: 'message_start', message: { id: 'msg_sync', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SYNC_OK' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  }).listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const { config } = await webdavFixture(t), sourceProject = path.join(dir, 'project'); fs.mkdirSync(sourceProject); fs.writeFileSync(path.join(sourceProject, 'file'), 'project content');
  const homes = ['a', 'b'].map(name => path.join(dir, name, 'claude'));
  for (const home of homes) { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_AUTH_TOKEN: 'local-fixture', ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' } })); }
  async function run(home, cwd, prompt, id) {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' };
    for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_(?:OAUTH_TOKEN|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY|CUSTOM_HEADERS))/.test(key)) delete env[key];
    const child = spawn(binary, ['--print', '--verbose', '--output-format', 'stream-json', '--model', 'claude-fixture', '--tools', '', '--setting-sources', 'user', ...(id ? ['--resume', id] : []), prompt], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); }); let output = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.resume();
    const [code] = await once(child, 'exit'); assert.equal(code, 0, output.slice(-1500));
    return output.trim().split('\n').map(line => JSON.parse(line)).find(record => record.type === 'result');
  }
  const result = await run(homes[0], sourceProject, 'Remember source computer'); assert.equal(result.is_error, false);
  const [a, b] = homes.map((home, index) => new TaskSync({ root: path.join(dir, String(index), 'switch'), client: 'claude', claudeHome: home })); t.after(async () => { await a.close(); await b.close(); });
  await a.configure(config); await a.list(); await a.select({ id: result.session_id, enabled: true });
  await new Promise(resolve => setTimeout(resolve, 2100)); const sent = await a.run(); assert.equal(sent.tasks[0].status, 'synced', JSON.stringify(sent));
  await b.configure(config); const received = await b.run(); assert.equal(received.tasks[0].status, 'synced', JSON.stringify(received));
  const resumed = await run(homes[1], received.tasks[0].cwd, 'Continue on the other computer', result.session_id);
  assert.equal(resumed.session_id, result.session_id); assert.equal(resumed.is_error, false);
  assert.match(JSON.stringify(calls.at(-1).messages), /Remember source computer/); assert.match(JSON.stringify(calls.at(-1).messages), /Continue on the other computer/);
});
