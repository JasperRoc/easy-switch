import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { init, addProvider, activate, readState, atomic, aliasName, baseURL, setModel } from '../src/store.js';
import { createProxy } from '../src/proxy.js';

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, token: init(root).token };
}
const payload = { model: 'test', input: [{ role: 'user', content: 'hello' }] };
function send(url, token, data = payload) {
  return fetch(url + '/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(data) });
}

test('switch routes next request; old stream remains on old upstream; history and tool outputs survive', async t => {
  const { root, token } = fixture(t);
  const received = [];
  let finishA;
  let signalA;
  const startedA = new Promise(resolve => { signalA = resolve; });
  const makeUpstream = label => http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    received.push({ label, headers: req.headers, body: JSON.parse(raw) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: {"source":"${label}","part":1}\n\n`);
    if (label === 'A') { finishA = () => res.end('data: {"source":"A","part":2}\n\n'); signalA(); }
    else res.end('data: [DONE]\n\n');
  });
  const a = await listen(t, makeUpstream('A'));
  const b = await listen(t, makeUpstream('B'));
  addProvider('first', { type: 'api', baseUrl: a, apiKey: 'key-a' }, root);
  addProvider('second', { type: 'api', baseUrl: b, apiKey: 'key-b', model: 'model-b' }, root);
  const proxy = await listen(t, createProxy({ root }));
  const first = await send(proxy, token);
  await startedA;
  activate('second', root);
  const history = [
    ...payload.input,
    { type: 'function_call', name: 'shell', call_id: 'call_1', arguments: '{"command":"pwd"}' },
    { type: 'function_call_output', call_id: 'call_1', output: '/project' },
    { role: 'user', content: 'continue' },
  ];
  const second = await send(proxy, token, { ...payload, input: history });
  assert.equal(second.headers.get('x-switch-alias'), 'second');
  assert.match(await second.text(), /"B"/);
  finishA();
  assert.match(await first.text(), /"A","part":2/);
  assert.equal(received[0].headers.authorization, 'Bearer key-a');
  assert.equal(received[1].headers.authorization, 'Bearer key-b');
  assert.deepEqual(received[1].body.input, history);
  assert.equal(received[1].body.model, 'model-b');
  assert.equal(received[1].body.store, false);
});

test('account adapter isolates credentials and rereads updated login', async t => {
  const { root, token } = fixture(t);
  const accountHome = path.join(root, 'accounts', 'personal');
  const authFile = path.join(accountHome, 'auth.json');
  atomic(authFile, { tokens: { access_token: 'account-token', account_id: 'account-id' } });
  addProvider('personal', { type: 'account', accountHome }, root);
  const requests = [];
  const proxy = await listen(t, createProxy({ root, fetchImpl: async (url, options) => {
    requests.push({ url, ...options });
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } }));
  await (await send(proxy, token)).text();
  atomic(authFile, { tokens: { access_token: 'renewed-token', account_id: 'account-id' } });
  await (await send(proxy, token)).text();
  assert.equal(requests[0].url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(requests[0].headers.authorization, 'Bearer account-token');
  assert.equal(requests[1].headers.authorization, 'Bearer renewed-token');
  assert.equal(requests[0].headers['ChatGPT-Account-ID'], 'account-id');
  assert.equal(JSON.parse(requests[0].body).instructions, '');
});

test('rejects unauthorized, incremental and opaque context rather than silently losing history', async t => {
  const { root, token } = fixture(t);
  let calls = 0;
  const proxy = await listen(t, createProxy({ root, fetchImpl: async () => { calls++; throw Error('should not reach'); } }));
  assert.equal((await send(proxy, 'wrong')).status, 401);
  for (const data of [
    { ...payload, previous_response_id: 'resp_old' },
    { ...payload, conversation: 'conv_old' },
    { ...payload, input: [{ type: 'compaction', encrypted_content: 'opaque' }] },
    { ...payload, input: [{ type: 'item_reference', id: 'old' }] },
  ]) assert.equal((await send(proxy, token, data)).status, 400);
  assert.equal(calls, 0);
});

test('redacts upstream errors and never follows authentication redirects', async t => {
  const { root, token } = fixture(t);
  addProvider('api', { type: 'api', baseUrl: 'https://example.com/v1', apiKey: 'SECRET' }, root);
  const proxy = await listen(t, createProxy({ root, fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, 'error');
    return new Response('echoed SECRET', { status: 401 });
  } }));
  const response = await send(proxy, token);
  assert.equal(response.status, 401);
  assert.doesNotMatch(await response.text(), /SECRET/);
});

test('disconnect aborts upstream request', async t => {
  const { root, token } = fixture(t);
  addProvider('api', { type: 'api', baseUrl: 'https://example.com/v1', apiKey: 'key' }, root);
  let signal;
  const proxy = await listen(t, createProxy({ root, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {}\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } });
  } }));
  const controller = new AbortController();
  const response = await fetch(proxy + '/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(payload), signal: controller.signal });
  await response.body.getReader().read();
  const aborted = once(signal, 'abort');
  controller.abort();
  await aborted;
  assert.equal(signal.aborted, true);
});

test('store validates names, duplicates and URL schemes; secrets use private files', t => {
  const { root } = fixture(t);
  for (const name of ['../bad', 'service', '__proto__', '']) assert.throws(() => aliasName(name));
  for (const url of ['http://example.com', 'https://u:p@example.com', 'file:///tmp/test']) assert.throws(() => baseURL(url));
  assert.equal(baseURL(''), 'https://api.openai.com/v1');
  assert.equal(baseURL('   '), 'https://api.openai.com/v1');
  assert.equal(baseURL(' https://example.com/v1/ '), 'https://example.com/v1');
  assert.equal(baseURL('https://example.com/v1/'), 'https://example.com/v1');
  addProvider('personal', { type: 'api', apiKey: 'secret' }, root);
  assert.throws(() => addProvider('personal', {}, root));
  assert.throws(() => activate('missing', root));
  assert.equal(readState(root).active, 'personal');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(root, 'state.json')).mode & 0o777, 0o600);
});

test('subscription 401 starts reauthentication; later request uses new credentials', async t => {
  const { root, token } = fixture(t);
  const accountHome = path.join(root, 'accounts', 'personal');
  atomic(path.join(accountHome, 'auth.json'), { tokens: { access_token: 'expired', account_id: 'id' } });
  addProvider('personal', { type: 'account', accountHome }, root);
  let logins = 0;
  const proxy = await listen(t, createProxy({ root,
    reauth: { async prompt() { logins++; return 'Open https://auth.openai.com/codex/device and enter ABCD-12345'; }, close() {} },
    fetchImpl: async (_url, options) => options.headers.authorization === 'Bearer expired'
      ? new Response('unauthorized', { status: 401 })
      : new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }),
  }));
  const first = await send(proxy, token);
  assert.equal(first.status, 401);
  assert.match(await first.text(), /ABCD-12345/);
  assert.equal(logins, 1);
  atomic(path.join(accountHome, 'auth.json'), { tokens: { access_token: 'renewed', account_id: 'id' } });
  const second = await send(proxy, token);
  assert.equal(second.status, 200);
  await second.text();
  assert.equal(logins, 1);
});

test('quota rejection transparently retries subscription, preserves input, isolates model/credentials', async t => {
  const { root, token } = fixture(t);
  addProvider('api', { type: 'api', baseUrl: 'https://api.example/v1', apiKey: 'API_SECRET', model: 'api-model' }, root);
  const accountHome = path.join(root, 'accounts', 'sub');
  atomic(path.join(accountHome, 'auth.json'), { tokens: { access_token: 'SUB_SECRET', account_id: 'sub-id' } });
  addProvider('sub', { type: 'account', accountHome }, root);
  const calls = [];
  const proxy = await listen(t, createProxy({ root, fetchImpl: async (url, options) => {
    calls.push({ url, ...options, payload: JSON.parse(options.body) });
    if (url.startsWith('https://api.example')) return new Response('{"error":{"message":"团队 今日额度不足"}}', { status: 403 });
    return new Response('data: subscription\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } }));
  const history = [...payload.input, { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: 'done' }];
  const response = await send(proxy, token, { ...payload, input: history });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /subscription/);
  assert.equal(response.headers.get('x-switch-alias'), 'sub');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.authorization, 'Bearer API_SECRET');
  assert.equal(calls[0].headers['ChatGPT-Account-ID'], undefined);
  assert.equal(calls[1].headers.authorization, 'Bearer SUB_SECRET');
  assert.equal(calls[1].payload.model, 'test');
  assert.deepEqual(calls[1].payload.input, history);
  assert.equal(readState(root).active, 'sub');
  assert.equal(readState(root).reason, 'failover');
  await (await send(proxy, token)).text();
  assert.equal(calls.length, 3);
  assert.match(calls[2].url, /chatgpt.com/);
});

test('ordinary forbidden, server errors and transport failures never switch', async t => {
  for (const status of [403, 400, 500, 502, 0]) {
    const { root, token } = fixture(t);
    for (const alias of ['a', 'b']) addProvider(alias, { type: 'api', baseUrl: `https://${alias}.example/v1`, apiKey: alias }, root);
    let calls = 0;
    const proxy = await listen(t, createProxy({ root, fetchImpl: async () => {
      calls++;
      if (!status) throw Error('network');
      return new Response('Forbidden: access denied', { status });
    } }));
    const response = await send(proxy, token); await response.text();
    assert.equal(calls, 1);
    assert.equal(readState(root).active, 'a');
  }
});

test('cooldown prevents ping pong, expires after 60 seconds, manual selection resets it', async t => {
  const { root, token } = fixture(t);
  for (const alias of ['a', 'b']) addProvider(alias, { type: 'api', baseUrl: `https://${alias}.example/v1`, apiKey: alias }, root);
  let clock = 0; const calls = [];
  const proxy = await listen(t, createProxy({ root, now: () => clock, fetchImpl: async url => {
    calls.push(url); return new Response('quota', { status: 429 });
  } }));
  await (await send(proxy, token)).text();
  assert.equal(calls.length, 2); // a -> b; never a third attempt
  await (await send(proxy, token)).text();
  assert.equal(calls.length, 3); // b; a still cooling
  clock = 60001;
  await (await send(proxy, token)).text();
  assert.equal(calls.length, 5); // b -> a
  activate('a', root);
  await (await send(proxy, token)).text();
  assert.equal(calls.length, 7); // manual a -> b despite previous cooldown
});

test('late rejection cannot override a newer manual choice, even the same alias', async t => {
  const { root, token } = fixture(t);
  for (const alias of ['a', 'b']) addProvider(alias, { type: 'api', baseUrl: `https://${alias}.example/v1`, apiKey: alias }, root);
  let reject; let began;
  const started = new Promise(resolve => { began = resolve; });
  let calls = 0;
  const proxy = await listen(t, createProxy({ root, fetchImpl: async () => {
    calls++; began(); return new Promise(resolve => { reject = resolve; });
  } }));
  const pending = send(proxy, token);
  await started;
  activate('a', root);
  reject(new Response('quota', { status: 402 }));
  const response = await pending;
  assert.equal(response.status, 402); await response.text();
  assert.equal(calls, 1);
  assert.equal(readState(root).reason, 'manual');
});

test('HTTP 200 SSE errors are delivered without a fallback', async t => {
  const { root, token } = fixture(t);
  for (const alias of ['a', 'b']) addProvider(alias, { type: 'api', baseUrl: `https://${alias}.example/v1`, apiKey: alias }, root);
  let calls = 0;
  const proxy = await listen(t, createProxy({ root, fetchImpl: async () => {
    calls++; return new Response('data: {"type":"response.failed","error":{"code":"insufficient_quota"}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } }));
  const response = await send(proxy, token);
  assert.match(await response.text(), /response.failed/);
  assert.equal(calls, 1);
  assert.equal(readState(root).active, 'a');
});

test('quota failover exhausts the available queue without revisiting aliases', async t => {
  const { root, token } = fixture(t);
  for (const alias of ['a', 'b', 'c']) addProvider(alias, { type: 'api', baseUrl: `https://${alias}.example/v1`, apiKey: alias }, root);
  const calls = [];
  let allFail = false;
  const proxy = await listen(t, createProxy({ root, fetchImpl: async url => {
    calls.push(new URL(url).hostname[0]);
    return !allFail && calls.at(-1) === 'c'
      ? new Response('data: complete\n\n', { headers: { 'content-type': 'text/event-stream' } })
      : new Response('quota', { status: 429 });
  } }));
  assert.equal((await send(proxy, token)).status, 200);
  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.equal(readState(root).active, 'c');
  allFail = true; calls.length = 0; activate('a', root);
  const response = await send(proxy, token); await response.text();
  assert.equal(response.status, 429);
  assert.deepEqual(calls, ['a', 'b', 'c']);
});

test('manual selection during a rejected request continues on the selected upstream', async t => {
  const { root, token } = fixture(t);
  for (const alias of ['a', 'b', 'c']) addProvider(alias, { type: 'api', baseUrl: `https://${alias}.example/v1`, apiKey: alias }, root);
  const calls = [];
  const proxy = await listen(t, createProxy({ root, fetchImpl: async url => {
    const alias = new URL(url).hostname[0]; calls.push(alias);
    if (alias === 'a') {
      activate('c', root);
      return new Response('quota', { status: 402 });
    }
    return new Response('data: continued\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } }));
  const response = await send(proxy, token);
  assert.equal(response.status, 200); assert.match(await response.text(), /continued/);
  assert.deepEqual(calls, ['a', 'c']);
  assert.equal(readState(root).reason, 'manual');
});

test('missing Content-Type accepts split SSE prefixes without losing response bytes', async t => {
  const { root, token } = fixture(t);
  addProvider('api', { type: 'api', baseUrl: 'https://example.com/v1', apiKey: 'mock' }, root);
  const chunks = ['\uFEFF', 'ev', 'ent: response.created\n', 'data: {"type":"response.created"}\n\n', 'data: {"type":"response.completed"}\n\n'];
  const expected = chunks.join('');
  const proxy = await listen(t, createProxy({ root, fetchImpl: async () => {
    const pending = [...chunks];
    return new Response(new ReadableStream({
      pull(controller) {
        if (pending.length) controller.enqueue(new TextEncoder().encode(pending.shift()));
        else controller.close();
      },
    }));
  } }));
  const response = await send(proxy, token);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), expected);
});

test('missing Content-Type still rejects HTML, JSON, empty and oversized preambles', async t => {
  for (const body of ['<html><title>Login</title></html>', '{"error":{"message":"mock"}}', '', ' '.repeat(16384) + 'data: too late\n\n']) {
    const { root, token } = fixture(t);
    addProvider('api', { type: 'api', baseUrl: 'https://example.com/v1', apiKey: 'mock' }, root);
    let cancelled = false;
    const proxy = await listen(t, createProxy({ root, fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { if (body) controller.enqueue(new TextEncoder().encode(body)); else controller.close(); },
      cancel() { cancelled = true; },
    })) }));
    const response = await send(proxy, token);
    assert.equal(response.status, 502);
    assert.match(await response.text(), /上游未返回 Responses SSE 流/);
    if (body) assert.equal(cancelled, true);
  }
});

test('Content-Type comparison is case insensitive but does not override explicit JSON', async t => {
  for (const [type, status] of [['Text/Event-Stream; charset=utf-8', 200], ['application/json', 502], ['text/event-stream-invalid', 502]]) {
    const { root, token } = fixture(t);
    addProvider('api', { type: 'api', baseUrl: 'https://example.com/v1', apiKey: 'mock' }, root);
    const proxy = await listen(t, createProxy({ root, fetchImpl: async () => new Response('data: {}\n\n', { headers: { 'content-type': type } }) }));
    const response = await send(proxy, token); await response.text();
    assert.equal(response.status, status);
  }
});

test('disconnect cancels an upstream SSE body accepted without Content-Type', async t => {
  const { root, token } = fixture(t);
  addProvider('api', { type: 'api', baseUrl: 'https://example.com/v1', apiKey: 'mock' }, root);
  let cancelled;
  const cancellation = new Promise(resolve => { cancelled = resolve; });
  const proxy = await listen(t, createProxy({ root, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('event: response.created\n\n')); },
    cancel() { cancelled(); },
  })) }));
  const abort = new AbortController();
  const response = await fetch(proxy + '/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: abort.signal });
  await response.body.getReader().read();
  abort.abort();
  await cancellation;
});


test('model/effort changes apply to new requests while existing SSE and tool history survive', async t => {
  const { root, token } = fixture(t);
  addProvider('api', { type: 'api', baseUrl: 'https://example.com/v1', apiKey: 'mock' }, root);
  const requests = []; let finish;
  const proxy = await listen(t, createProxy({ root, fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: first\n\n'));
      finish = () => { controller.enqueue(new TextEncoder().encode('data: done\n\n')); controller.close(); };
    } }), { headers: { 'content-type': 'text/event-stream' } });
    return new Response('data: done\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } }));
  const first = await send(proxy, token, { ...payload, reasoning: { effort: 'low', summary: 'auto' } });
  setModel({ model: 'model-next', effort: 'high' }, root);
  const input = [...payload.input, { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: 'done' }];
  await (await send(proxy, token, { ...payload, input, reasoning: { effort: 'low', summary: 'auto' } })).text();
  finish(); assert.match(await first.text(), /first/);
  assert.equal(requests[0].model, 'test'); assert.equal(requests[0].reasoning.effort, 'low');
  assert.equal(requests[1].model, 'model-next'); assert.deepEqual(requests[1].reasoning, { effort: 'high', summary: 'auto' });
  assert.deepEqual(requests[1].input, input);
  setModel(null, root);
  await (await send(proxy, token, { ...payload, reasoning: { effort: 'medium' } })).text();
  assert.equal(requests[2].model, 'test'); assert.equal(requests[2].reasoning.effort, 'medium');
});

test('failover keeps one model selection snapshot, including when settings change during rejection', async t => {
  const { root, token } = fixture(t);
  for (const alias of ['a', 'b']) addProvider(alias, { type: 'api', baseUrl: `https://${alias}.example/v1`, apiKey: alias, model: 'legacy-model' }, root);
  setModel({ model: 'chosen-model', effort: 'high' }, root);
  const requests = [];
  const proxy = await listen(t, createProxy({ root, fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) { setModel({ model: 'later-model', effort: 'low' }, root); return new Response('quota', { status: 429 }); }
    return new Response('data: done\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } }));
  await (await send(proxy, token)).text();
  assert.equal(requests.length, 2);
  for (const request of requests) { assert.equal(request.model, 'chosen-model'); assert.equal(request.reasoning.effort, 'high'); }
  await (await send(proxy, token)).text();
  assert.equal(requests[2].model, 'later-model');
});
