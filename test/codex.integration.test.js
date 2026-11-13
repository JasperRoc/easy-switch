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
import { init, addProvider, removeProvider, activate, readState, atomic } from '../src/store.js';
import { createProxy } from '../src/proxy.js';
import { prepareConfig } from '../src/install.js';
import { activateSession } from '../desktop/config.js';

for (const nativeAuth of [false, true, 'bridge', 'free']) test(`real Codex app-server (${nativeAuth === 'bridge' ? 'API login bridged to subscription tools' : nativeAuth === 'free' ? 'Free login bridged to paid image tools' : nativeAuth ? 'native subscription tools' : 'API mode'}): same thread, failover and client models preserve parallel tasks and tool continuation`, { skip: !process.env.SWITCH_TEST_CODEX, timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-codex-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'switch');
  const codexHome = path.join(dir, 'codex');
  fs.mkdirSync(codexHome);
  const { token } = init(root);
  const requests = [];
  let rejectA = false;
  let toolTurn = false, toolIssued = false, finishToolResponse, signalTool;
  const toolReady = new Promise(resolve => { signalTool = resolve; });
  let pauseNext = false, signalPaused;
  const paused = new Promise(resolve => { signalPaused = resolve; });
  let imageTurn = false, imageIssued = false, imageCalls = 0, capacityNext = false;
  async function serve(server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    return `http://127.0.0.1:${server.address().port}`;
  }
  const upstream = label => http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: `provider-${label}-only` }, { id: 'gpt-image-2' }, { id: 'gpt-5.6-sol' }, { id: 'gpt-6-luna' }, { id: 'gpt-6.1-terra' }, { id: 'gpt-6-astra' }, { id: 'gpt-6.1-sol' }] }));
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ label, body, authorization: req.headers.authorization, accountID: req.headers['chatgpt-account-id'] });
    if (label === 'A' && rejectA) {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Forbidden' } }));
    }
    const id = `resp_${label}`;
    const item = { id: `msg_${label}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `reply ${label}`, annotations: [] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = data => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    event({ type: 'response.created', response: { id, status: 'in_progress', output: [] } });
    if (capacityNext) {
      capacityNext = false;
      event({ type: 'response.failed', response: { id, error: { code: 'server_overloaded', message: 'Selected model is at capacity. Please try a different model.' } } });
      return res.end();
    }
    if (pauseNext) {
      const closed = once(res, 'close'); signalPaused(); await closed; return;
    }
    if (imageTurn && !imageIssued) {
      imageIssued = true;
      const call = { type: 'function_call', id: 'fc_image', call_id: 'call_image', namespace: 'image_gen', name: 'imagegen', arguments: JSON.stringify({ prompt: 'A blue square' }), status: 'completed' };
      event({ type: 'response.output_item.added', output_index: 0, item: call });
      event({ type: 'response.output_item.done', output_index: 0, item: call });
      event({ type: 'response.completed', response: { id, status: 'completed', output: [call] } });
      return res.end();
    }
    if (toolTurn && !toolIssued) {
      toolIssued = true;
      const call = { type: 'function_call', id: 'fc_continuation', call_id: 'call_continuation', name: 'exec_command', arguments: JSON.stringify({ cmd: 'sleep 1; printf switch-tool-ok', login: false }), status: 'completed' };
      event({ type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '', status: 'in_progress' } });
      event({ type: 'response.function_call_arguments.delta', item_id: call.id, output_index: 0, delta: call.arguments });
      event({ type: 'response.function_call_arguments.done', item_id: call.id, output_index: 0, arguments: call.arguments });
      event({ type: 'response.output_item.done', output_index: 0, item: call });
      const proceed = new Promise(resolve => { finishToolResponse = resolve; });
      signalTool();
      await proceed;
      event({ type: 'response.completed', response: { id, status: 'completed', output: [call], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } });
      return res.end();
    }
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
  const proxy = await serve(createProxy({ root, binary: process.env.SWITCH_TEST_CODEX, wait: async () => {}, fetchImpl: async (url, options) => {
    if (url.endsWith('/images/generations')) {
      imageCalls++;
      assert.equal(options.headers.authorization, 'Bearer fixture-subscription');
      assert.equal(url, 'https://chatgpt.com/backend-api/codex/images/generations');
      assert.equal(JSON.parse(options.body).model, 'gpt-image-2');
      assert.equal(typeof options.headers.originator, 'string');
      assert.match(options.headers['user-agent'], /0\.165\.0/);
      assert.equal(typeof options.headers['x-codex-image-turn-id'], 'string');
      assert.ok(options.headers['x-codex-image-turn-id'].length > 0, 'native image turn context survives subscription routing');
      return Response.json({ created: 1, data: [{ b64_json: fs.readFileSync(new URL('../desktop/assets/icon.png', import.meta.url)).toString('base64') }] });
    }
    assert.ok(url.startsWith('http://127.0.0.1:'), 'test traffic must stay on simulated upstreams');
    return fetch(url, options);
  } }));
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model="gpt-6.1-sol"\n' + (nativeAuth === 'bridge' ? 'cli_auth_credentials_store="keyring"\nforced_login_method="api"\n' : '[features]\nimage_generation=true\n'));
  if (nativeAuth) {
    const jwt = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture', chatgpt_plan_type: nativeAuth === 'free' ? 'free' : 'plus' }, exp: 4102444800 })).toString('base64url') + '.fixture';
    const auth = { tokens: { id_token: jwt, access_token: jwt, refresh_token: 'fixture', account_id: 'fixture' }, last_refresh: new Date().toISOString() };
    if (nativeAuth === 'bridge') {
      const accountHome = path.join(root, 'accounts', 'subscription');
      atomic(path.join(accountHome, 'auth.json'), auth);
      addProvider('subscription', { type: 'account', accountHome }, root);
      atomic(path.join(codexHome, 'auth.json'), { auth_mode: 'apikey', OPENAI_API_KEY: 'old-api-fixture' });
    } else {
      atomic(path.join(codexHome, 'auth.json'), auth);
      if (nativeAuth === 'free') {
        const accountHome = path.join(root, 'accounts', 'subscription');
        const paid = 'fixture.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' }, exp: 4102444800 })).toString('base64url') + '.fixture';
        atomic(path.join(accountHome, 'auth.json'), { ...auth, tokens: { ...auth.tokens, access_token: paid, id_token: paid } });
        addProvider('subscription', { type: 'account', accountHome }, root);
      }
    }
    activateSession(root, codexHome, Number(new URL(proxy).port), token);
    // Keep the text failover scenarios identical; the copied native sign-in
    // still exercises tool exposure with no original native subscription.
    if (nativeAuth === 'bridge' || nativeAuth === 'free') removeProvider('subscription', root);
  } else prepareConfig(root, codexHome, Number(new URL(proxy).port), token).apply();
  const child = spawn(process.env.SWITCH_TEST_CODEX, ['app-server'], { cwd: dir, env: { ...process.env, CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } });
  let stderr = '';
  child.stderr.on('data', c => { stderr += c; });
  const pending = new Map();
  let nextId = 1;
  const finishTurns = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.id != null && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
    }
    if (message.method === 'turn/completed') finishTurns.get(message.params.threadId)?.(message.params.turn);
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
  const models = await call('model/list', { includeHidden: false });
  assert.deepEqual(models.data.map(model => model.model), ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-sol', 'provider-A-only', 'provider-B-only'], 'official Codex keeps official model order ahead of provider-specific models: ' + stderr);
  assert.equal(models.data[0].displayName, 'GPT-6.1-Sol');
  assert.equal(models.data[0].defaultReasoningEffort, 'low');
  assert.deepEqual(models.data[0].supportedReasoningEfforts.map(level => level.reasoningEffort), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(models.data[3].supportedReasoningEfforts.map(level => level.reasoningEffort), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(models.data[5].supportedReasoningEfforts, [], 'unrecognized vendor models do not inherit invented effort support');
  const { thread } = await call('thread/start', { cwd: dir, approvalPolicy: 'never', sandbox: 'read-only' });
  for (const [alias, text] of [['a', 'First turn'], ['b', 'Second turn']]) {
    activate(alias, root);
    const completed = new Promise(resolve => { finishTurns.set(thread.id, resolve); });
    await call('turn/start', { threadId: thread.id, effort: 'high', input: [{ type: 'text', text, text_elements: [] }] });
    const turn = await completed;
    assert.equal(turn.status, 'completed', JSON.stringify(turn) + stderr);
  }
  assert.deepEqual(requests.map(r => r.label), ['A', 'B']);
  assert.ok(requests.every(r => r.body.model === 'gpt-6.1-sol' && r.body.reasoning?.effort === 'high'), 'effort selected in the actual Codex client must reach both upstreams');
  assert.deepEqual(requests.map(r => r.authorization), ['Bearer a', 'Bearer b'], 'API switches replace the native subscription bearer with the selected API key');
  assert.ok(requests.every(r => r.accountID === undefined), 'the native subscription identity never leaks to API providers');
  if (nativeAuth === 'bridge') assert.equal(JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'))).auth_mode, 'chatgpt');
  const second = JSON.stringify(requests[1].body.input);
  assert.match(second, /First turn/);
  assert.match(second, /reply A/);
  assert.match(second, /Second turn/);
  assert.equal(child.exitCode, null);
  await call('thread/name/set', { threadId: thread.id, name: 'Named task in Codex' });
  rejectA = true;
  activate('a', root);
  const completed = new Promise(resolve => { finishTurns.set(thread.id, resolve); });
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
  // A client tool continuation preserves the native model within the same turn.
  toolTurn = true;
  const toolCompleted = new Promise(resolve => { finishTurns.set(thread.id, resolve); });
  const started = await call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Tool turn: run the tool and continue.', text_elements: [] }] });
  await toolReady;
  const originalTool = requests.at(-1);
  const other = (await call('thread/start', { cwd: dir, approvalPolicy: 'never', sandbox: 'read-only' })).thread;
  const otherCompleted = new Promise(resolve => { finishTurns.set(other.id, resolve); });
  await call('turn/start', { threadId: other.id, effort: 'high', input: [{ type: 'text', text: 'An independent parallel task', text_elements: [] }] });
  assert.equal((await otherCompleted).status, 'completed');
  assert.equal(requests.at(-1).body.model, requests[0].body.model);
  assert.equal(requests.at(-1).body.reasoning.effort, requests[0].body.reasoning.effort);
  assert.equal(originalTool.body.model, requests[0].body.model);
  finishToolResponse();
  const finished = await toolCompleted;
  assert.equal(finished.id, started.turn.id);
  assert.equal(finished.status, 'completed', JSON.stringify(finished) + stderr);
  assert.equal(requests.at(-2).body.model, requests[0].body.model);
  assert.equal(requests.at(-2).body.reasoning.effort, requests[0].body.reasoning.effort);
  assert.equal(requests.at(-1).body.model, requests[0].body.model);
  assert.equal(requests.at(-1).body.reasoning.effort, requests[0].body.reasoning.effort);
  const output = requests.at(-1).body.input.find(item => item.type === 'function_call_output' && item.call_id === 'call_continuation');
  assert.match(output.output, /switch-tool-ok/);
  assert.equal(child.exitCode, null);
  capacityNext = true;
  const capacityCompleted = new Promise(resolve => { finishTurns.set(thread.id, resolve); });
  await call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Continue through a capacity rejection', text_elements: [] }] });
  assert.equal((await capacityCompleted).status, 'completed', 'the same turn continues without another turn/start');
  if (nativeAuth) {
    const accountHome = path.join(root, 'accounts', 'image-subscription');
    const jwt = 'fixture.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'free' } })).toString('base64url') + '.fixture';
    if (nativeAuth === 'free') {
      const freeHome = path.join(root, 'accounts', 'free');
      atomic(path.join(freeHome, 'auth.json'), { tokens: { access_token: jwt, id_token: jwt, account_id: 'free' } });
      addProvider('free', { type: 'account', accountHome: freeHome }, root);
    }
    atomic(path.join(accountHome, 'auth.json'), { tokens: { access_token: 'fixture-subscription', account_id: 'fixture' } });
    addProvider('images', { type: 'account', accountHome }, root);
    const textProvider = readState(root).active;
    imageTurn = true;
    const imageCompleted = new Promise(resolve => { finishTurns.set(thread.id, resolve); });
    await call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Generate an image, then continue this task.', text_elements: [] }] });
    assert.equal((await imageCompleted).status, 'completed');
    const result = requests.at(-1).body.input.find(item => item.type === 'function_call_output' && item.call_id === 'call_image');
    assert.equal(imageCalls, 1, 'the native image tool reaches an eligible image endpoint: ' + JSON.stringify(result));
    assert.doesNotMatch(JSON.stringify(result), /failed|unsupported call/);
    assert.match(JSON.stringify(result), /image_url|generated image|output_hint/);
    assert.equal(readState(root).active, textProvider, 'image generation leaves the text provider selected');
  }
  pauseNext = true;
  const interrupted = new Promise(resolve => { finishTurns.set(thread.id, resolve); });
  const last = await call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'This turn will be cancelled', text_elements: [] }] });
  await paused;
  await call('turn/interrupt', { threadId: thread.id, turnId: last.turn.id });
  assert.equal((await interrupted).status, 'interrupted');
});

test('real Codex with a Free login continues its same turn and model through an API after an explicit model-access rejection', { skip: !process.env.SWITCH_TEST_CODEX, timeout: 30000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-free-model-')), root = path.join(directory, 'switch'), codexHome = path.join(directory, 'codex');
  const { token } = init(root), accountHome = path.join(root, 'accounts', 'free');
  const jwt = 'fixture.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'free', chatgpt_plan_type: 'free' }, exp: 4102444800 })).toString('base64url') + '.fixture';
  const auth = { tokens: { access_token: jwt, id_token: jwt, account_id: 'free' } };
  atomic(path.join(accountHome, 'auth.json'), auth); atomic(path.join(codexHome, 'auth.json'), auth);
  addProvider('free', { type: 'account', accountHome }, root);
  addProvider('api', { type: 'api', baseUrl: 'https://api.example/v1', apiKey: 'fixture-api' }, root);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model="gpt-5.1-codex"\n');
  const calls = [];
  const server = createProxy({ root, fetchImpl: async (url, options) => {
    const payload = JSON.parse(options.body); calls.push({ url, payload, headers: options.headers });
    if (url.startsWith('https://chatgpt.com')) return Response.json({ detail: "The 'gpt-5.1-codex' model is not supported when using Codex with this ChatGPT account." }, { status: 400 });
    const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'API_OK', annotations: [] }] };
    const events = [{ type: 'response.created', response: { id: 'resp_fixture', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
    return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); activateSession(root, codexHome, server.address().port, token);
  const child = spawn(process.env.SWITCH_TEST_CODEX, ['app-server'], { cwd: directory, env: { ...process.env, CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    server.closeAllConnections(); server.close(); fs.rmSync(directory, { recursive: true, force: true });
  });
  child.stderr.resume(); const pending = new Map(); let next = 1, completed;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (pending.has(message.id)) { const { resolve, reject } = pending.get(message.id); pending.delete(message.id); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result); }
    if (message.method === 'turn/completed') completed?.(message.params.turn);
  });
  const call = (method, params) => new Promise((resolve, reject) => { const id = next++; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); });
  await call('initialize', { clientInfo: { name: 'switch_free_test', version: '0.1.0' } });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  const { thread } = await call('thread/start', { cwd: directory, approvalPolicy: 'never', sandbox: 'read-only' });
  for (const text of ['First message', 'Continue in this same conversation']) {
    const turn = new Promise(resolve => { completed = resolve; });
    await call('turn/start', { threadId: thread.id, input: [{ type: 'text', text, text_elements: [] }] });
    assert.equal((await turn).status, 'completed');
  }
  assert.equal(calls.length, 3); assert.ok(calls[0].url.startsWith('https://chatgpt.com'));
  assert.ok(calls.slice(1).every(call => call.url === 'https://api.example/v1/responses' && call.headers.authorization === 'Bearer fixture-api'));
  assert.ok(calls.every(call => call.payload.model === 'gpt-5.1-codex'));
  assert.match(JSON.stringify(calls.at(-1).payload.input), /First message/);
  assert.equal(readState(root).active, 'free');
});
