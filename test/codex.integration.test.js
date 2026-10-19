// Opt-in: uses the installed Codex binary, but only local mock upstreams and temporary homes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import { init, addProvider, activate, readState } from '../src/store.js';
import { createProxy } from '../src/proxy.js';
import { prepareConfig } from '../src/install.js';

test('real Codex app-server: same process, same thread, manual switch and quota failover', { skip: !process.env.SWITCH_TEST_CODEX, timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-codex-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'switch');
  const codexHome = path.join(dir, 'codex');
  fs.mkdirSync(codexHome);
  const { token } = init(root);
  const requests = [];
  let rejectA = false;
  async function serve(server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    return `http://127.0.0.1:${server.address().port}`;
  }
  const upstream = label => http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ label, body });
    if (label === 'A' && rejectA) {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'insufficient quota' } }));
    }
    const id = `resp_${label}`;
    const item = { id: `msg_${label}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `reply ${label}`, annotations: [] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = data => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    event({ type: 'response.created', response: { id, status: 'in_progress', output: [] } });
    event({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    event({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    event({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: `reply ${label}` });
    event({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: `reply ${label}` });
    event({ type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
    event({ type: 'response.output_item.done', output_index: 0, item });
    event({ type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } });
    res.end();
  });
  addProvider('a', { type: 'api', baseUrl: await serve(upstream('A')), apiKey: 'a' }, root);
  addProvider('b', { type: 'api', baseUrl: await serve(upstream('B')), apiKey: 'b' }, root);
  const proxy = await serve(createProxy({ root }));
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model="gpt-5.1-codex"\n');
  prepareConfig(root, codexHome, Number(new URL(proxy).port), token).apply();
  const child = spawn(process.env.SWITCH_TEST_CODEX, ['app-server'], { cwd: dir, env: { ...process.env, CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } });
  let stderr = '';
  child.stderr.on('data', c => { stderr += c; });
  const pending = new Map();
  let nextId = 1;
  let finishTurn;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.id != null && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
    }
    if (message.method === 'turn/completed') finishTurn?.(message.params.turn);
  });
  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  await call('initialize', { clientInfo: { name: 'switch_test', version: '0.1.0' } });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  const { thread } = await call('thread/start', { cwd: dir, approvalPolicy: 'never', sandbox: 'read-only' });
  for (const [alias, text] of [['a', 'First turn'], ['b', 'Second turn']]) {
    activate(alias, root);
    const completed = new Promise(resolve => { finishTurn = resolve; });
    await call('turn/start', { threadId: thread.id, input: [{ type: 'text', text, text_elements: [] }] });
    const turn = await completed;
    assert.equal(turn.status, 'completed', JSON.stringify(turn) + stderr);
  }
  assert.deepEqual(requests.map(r => r.label), ['A', 'B']);
  const second = JSON.stringify(requests[1].body.input);
  assert.match(second, /First turn/);
  assert.match(second, /reply A/);
  assert.match(second, /Second turn/);
  assert.equal(child.exitCode, null);
  rejectA = true;
  activate('a', root);
  const completed = new Promise(resolve => { finishTurn = resolve; });
  await call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Third turn', text_elements: [] }] });
  const turn = await completed;
  assert.equal(turn.status, 'completed', JSON.stringify(turn) + stderr);
  assert.deepEqual(requests.map(r => r.label), ['A', 'B', 'A', 'B']);
  assert.deepEqual(requests[2].body.input, requests[3].body.input);
  assert.match(JSON.stringify(requests[3].body.input), /First turn/);
  assert.match(JSON.stringify(requests[3].body.input), /Second turn/);
  assert.match(JSON.stringify(requests[3].body.input), /Third turn/);
  assert.equal(readState(root).active, 'b');
  assert.equal(readState(root).reason, 'failover');
  assert.equal(child.exitCode, null);
});
