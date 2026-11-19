import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { init, atomic, addProvider, editProvider, removeProvider, activate, readState } from '../src/store.js';
import { createClaudeHandler } from '../src/claude-proxy.js';
import http from 'node:http';

async function setup(t, fetchImpl, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-claude-gateway-'));
  const { token } = init(root);
  const server = http.createServer(createClaudeHandler({ root, fetchImpl, wait: async () => {}, ...extra }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${token}` };
  const catalog = async (prefix = '/claude-desktop') => {
    const response = await fetch(base + prefix + '/v1/models', { headers });
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  };
  const messages = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { file: 'example' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'file result' }] }];
  const tools = [{ name: 'Read', input_schema: { type: 'object', properties: {} } }];
  const send = (model, prefix = '/claude-desktop') => fetch(base + prefix + '/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model, messages, tools, max_tokens: 32 }) });
  return { root, token, base, headers, catalog, send, messages, tools };
}
const provider = alias => ({ type: 'api', baseUrl: `https://${alias}.test`, apiKey: alias + '-secret' });
const message = model => Response.json({ type: 'message', model, content: [{ type: 'text', text: 'OK' }] });

test('gateway catalog is a stable client-compatible union, tolerates unavailable providers and refreshes edits', async t => {
  let time = 0;
  const queries = [], catalogs = { a: ['deepseek-v4-pro', 'deepseek-v4-flash'], b: ['deepseek-v4-flash', 'claude-sonnet-test'] };
  const gateway = await setup(t, async url => {
    const alias = new URL(url).hostname.split('.')[0]; queries.push(alias);
    return catalogs[alias] ? Response.json({ data: catalogs[alias].map(id => ({ id })) }) : new Response('', { status: 401 });
  }, { now: () => time });
  for (const alias of ['a', 'b', 'broken']) addProvider(alias, provider(alias), gateway.root);
  const first = await gateway.catalog();
  assert.deepEqual(first.data.map(item => item.display_name), ['deepseek-v4-pro', 'deepseek-v4-flash', 'claude-sonnet-test']);
  assert.ok(first.data.every(item => item.description.startsWith('easy-switch · ')));
  assert.equal(new Set(first.data.map(item => item.id)).size, 3);
  const raw = await gateway.catalog('/claude');
  assert.deepEqual(raw, first, 'both clients need discoverable route IDs and the original display names');
  activate('b', gateway.root);
  assert.deepEqual(await gateway.catalog(), first, 'provider switches cannot alter the gateway model identity');
  assert.deepEqual(queries, ['a', 'b', 'broken'], 'failed discovery is cached without background polling');
  catalogs.b = ['new-model']; editProvider('b', { apiKey: 'revised-secret' }, gateway.root);
  assert.deepEqual((await gateway.catalog()).data.map(item => item.display_name), ['deepseek-v4-pro', 'deepseek-v4-flash', 'new-model']);
  delete catalogs.a; time += 61000;
  assert.deepEqual((await gateway.catalog()).data.map(item => item.display_name), ['deepseek-v4-pro', 'deepseek-v4-flash', 'new-model'], 'a transient discovery error retains previously observed IDs');
  removeProvider('a', gateway.root);
  assert.deepEqual((await gateway.catalog()).data.map(item => item.display_name), ['new-model']);
});

test('edited catalog labels never replace Claude upstream IDs and resetting restores provider discovery', async t => {
  const requests = [];
  const gateway = await setup(t, async (url, options) => {
    if (!options.method) return Response.json({ data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }] });
    requests.push(JSON.parse(options.body)); return message(requests.at(-1).model);
  });
  addProvider('api', provider('api'), gateway.root);
  editProvider('api', { modelCatalog: [{ id: 'deepseek-v4-pro', label: 'DeepSeek Pro' }] }, gateway.root);
  const result = await gateway.catalog();
  assert.deepEqual(result.data.map(model => model.display_name), ['DeepSeek Pro']);
  const response = await gateway.send(result.data[0].id); await response.text();
  assert.equal(requests[0].model, 'deepseek-v4-pro');
  assert.deepEqual(requests[0].messages, gateway.messages);
  editProvider('api', { modelCatalog: null }, gateway.root);
  assert.deepEqual((await gateway.catalog()).data.map(model => model.display_name), ['deepseek-v4-pro', 'deepseek-v4-flash']);
});

test('all three selected models keep their IDs and history through rate limits and unsupported subscriptions', async t => {
  const ids = ['deepseek-v4-pro', 'deepseek-v4-1-flash', 'deepseek-v4-flash'];
  const calls = []; let rejected = false, accountRefreshes = 0;
  const gateway = await setup(t, async (url, options) => {
    if (url.includes('/oauth/token')) { accountRefreshes++; return new Response('', { status: 400 }); }
    if (!options.body) return Response.json({ data: ids.map(id => ({ id })) });
    const payload = JSON.parse(options.body), alias = new URL(url).hostname.split('.')[0]; calls.push({ alias, payload });
    return alias === 'a' && rejected ? Response.json({ error: { type: 'rate_limit_error', message: 'model channel busy' } }, { status: 429 }) : message(payload.model);
  });
  addProvider('a', provider('a'), gateway.root);
  const accountHome = path.join(gateway.root, 'account'); atomic(path.join(accountHome, 'oauth.json'), { accessToken: 'expired-account', expiresAt: 1 });
  addProvider('sub', { type: 'account', accountHome }, gateway.root);
  addProvider('b', { ...provider('b'), claudeModels: { default: ids[0], subagent: ids[0] } }, gateway.root);
  const catalog = await gateway.catalog();
  for (const entry of catalog.data) {
    activate('a', gateway.root); rejected = true;
    const before = calls.length;
    const response = await gateway.send(entry.id + '[1m]');
    assert.equal(response.status, 200); assert.equal(response.headers.get('x-switch-alias'), 'b');
    assert.equal((await response.json()).model, entry.display_name);
    assert.deepEqual(calls.slice(before).map(call => call.alias), ['a', 'b']);
    for (const call of calls.slice(before)) {
      assert.equal(call.payload.model, entry.display_name);
      assert.deepEqual(call.payload.messages, gateway.messages); assert.deepEqual(call.payload.tools, gateway.tools);
    }
    assert.equal(readState(gateway.root).active, 'b');
  }
  assert.equal(accountRefreshes, 0, 'a Claude-only subscription is not an inference candidate for DeepSeek');
});

test('both clients list three subscription models beside three API models and route all six', async t => {
  const official = ['claude-fable-5', 'claude-opus-5', 'claude-haiku-5'], ids = ['deepseek-v4-pro', 'deepseek-v4-1-flash', 'deepseek-v4-flash'];
  const calls = [];
  const gateway = await setup(t, async (url, options) => {
    const account = url.includes('api.anthropic.com');
    if (!options.body) return Response.json({ data: (account ? official : ids).map(id => ({ id })) });
    calls.push({ account, payload: JSON.parse(options.body) }); return message(calls.at(-1).payload.model);
  });
  const accountHome = path.join(gateway.root, 'subscription'); atomic(path.join(accountHome, 'oauth.json'), { accessToken: 'fixture-subscription', expiresAt: Date.now() + 3600000 });
  addProvider('subscription', { type: 'account', accountHome }, gateway.root);
  addProvider('api', provider('api'), gateway.root);
  for (const prefix of ['/claude-desktop', '/claude']) {
    const catalog = await gateway.catalog(prefix);
    assert.deepEqual(catalog.data.map(item => item.display_name), [...official, ...ids]);
    assert.ok(catalog.data.every(item => /claude|anthropic/i.test(item.id)), 'CLI filters IDs without either substring');
    for (const [index, entry] of catalog.data.entries()) {
      activate('subscription', gateway.root);
      const response = await gateway.send(entry.id + '[1m]', prefix);
      assert.equal(response.status, 200); assert.equal((await response.json()).model, entry.display_name);
      assert.equal(calls.at(-1).account, index < 3);
      assert.deepEqual(calls.at(-1).payload.messages, gateway.messages);
    }
  }
});

test('family mappings are independent and fallback reapplies each provider mapping or the original subscription model', async t => {
  const ids = ['deepseek-v4-pro', 'deepseek-v4-1-flash', 'deepseek-v4-flash'], calls = [];
  const mapping = { fable: ids[0], opus: ids[1], haiku: ids[2] };
  let reject = false;
  const gateway = await setup(t, async (url, options) => {
    const account = url.includes('api.anthropic.com'), alias = new URL(url).hostname.split('.')[0];
    if (!options.body) return Response.json({ data: (account ? ['claude-fable-5', 'claude-opus-5', 'claude-haiku-5'] : ids).map(id => ({ id })) });
    calls.push({ alias, payload: JSON.parse(options.body), key: options.headers['x-api-key'] });
    if (reject && alias === 'a') return Response.json({ error: { type: 'rate_limit_error' } }, { status: 429 });
    return message(calls.at(-1).payload.model);
  });
  addProvider('a', { ...provider('a'), claudeModels: mapping }, gateway.root);
  const accountHome = path.join(gateway.root, 'subscription'); atomic(path.join(accountHome, 'oauth.json'), { accessToken: 'fixture-account', expiresAt: Date.now() + 3600000 });
  addProvider('subscription', { type: 'account', accountHome }, gateway.root);
  for (const prefix of ['/claude-desktop', '/claude']) {
    for (const [family, expected] of Object.entries(mapping)) {
      activate('a', gateway.root); reject = false;
      const response = await gateway.send(`claude-${family}-5[1m]`, prefix);
      assert.equal(response.status, 200); assert.equal((await response.json()).model, expected);
      assert.equal(calls.at(-1).alias, 'a');
      reject = true; activate('a', gateway.root);
      const before = calls.length, retried = await gateway.send(`claude-${family}-5[1m]`, prefix);
      assert.equal(retried.status, 200); assert.equal((await retried.json()).model, `claude-${family}-5`);
      assert.deepEqual(calls.slice(before).map(call => call.payload.model), [expected, `claude-${family}-5`]);
      for (const call of calls.slice(before)) { assert.deepEqual(call.payload.messages, gateway.messages); assert.deepEqual(call.payload.tools, gateway.tools); }
    }
    const catalog = await gateway.catalog(prefix), real = catalog.data.find(item => item.display_name === ids[1]);
    reject = false; activate('a', gateway.root);
    const response = await gateway.send(real.id, prefix); assert.equal(response.status, 200); assert.equal((await response.json()).model, ids[1]);
  }
  addProvider('b', { ...provider('b'), claudeModels: { fable: ids[2] } }, gateway.root);
  removeProvider('subscription', gateway.root);
  reject = true; activate('a', gateway.root);
  const before = calls.length, response = await gateway.send('claude-fable-5');
  assert.equal(response.status, 200); assert.equal((await response.json()).model, ids[2]);
  assert.deepEqual(calls.slice(before).map(call => [call.alias, call.payload.model]), [['a', ids[0]], ['b', ids[2]]]);
});

test('unavailable models fail over on HTTP, startup SSE and connection failures before accepting output', async t => {
  for (const style of ['http', 'sse', 'network', 'server']) {
    const calls = [];
    const gateway = await setup(t, async (url, options) => {
      if (!options.body) return Response.json({ data: [{ id: 'deepseek-v4-flash' }] });
      const model = JSON.parse(options.body).model; calls.push({ url, model });
      if (url.includes('a.test')) {
        if (style === 'network') throw new TypeError('fetch failed');
        if (style === 'server') return new Response('', { status: 503 });
        const error = { type: 'invalid_request_error', code: 'model_not_found', message: 'model is not available' };
        return style === 'sse' ? new Response(`event: error\ndata: ${JSON.stringify({ type: 'error', error })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }) : Response.json({ error }, { status: 400 });
      }
      return message(model);
    });
    for (const alias of ['a', 'b']) addProvider(alias, provider(alias), gateway.root);
    const selected = (await gateway.catalog()).data[0];
    const response = await gateway.send(selected.id);
    assert.equal(response.status, 200, style); await response.text();
    assert.deepEqual(calls.map(call => call.model), Array(['network', 'server'].includes(style) ? 7 : 2).fill('deepseek-v4-flash'), style);
    assert.equal(readState(gateway.root).active, 'b');
  }
});

test('Claude CLI and Desktop recover transient HTTP, connection and startup SSE failures on the selected provider', async t => {
  for (const prefix of ['/claude', '/claude-desktop']) for (const style of [500, 502, 503, 504, 529, 'network', 'sse', 'disconnect']) {
    const calls = [], waits = [];
    const gateway = await setup(t, async (url, options) => {
      if (!options.body) return Response.json({ data: [{ id: 'deepseek-v4-flash' }] });
      calls.push({ alias: new URL(url).hostname.split('.')[0], payload: JSON.parse(options.body) });
      if (calls.length > 5) return message(calls.at(-1).payload.model);
      if (style === 'network') throw new TypeError('fetch failed');
      const preamble = 'event: message_start\ndata: {"type":"message_start","message":{"content":[]}}\n\n';
      if (style === 'disconnect') return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(preamble)); }, pull(controller) { controller.error(new TypeError('connection closed')); } }), { headers: { 'content-type': 'text/event-stream' } });
      if (style === 'sse') return new Response(preamble + 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
      return new Response('Service Unavailable', { status: style });
    }, { wait: async ms => { waits.push(ms); assert.equal(readState(gateway.root).active, 'aos'); } });
    for (const alias of ['aos', 'elias']) addProvider(alias, provider(alias), gateway.root);
    const response = await gateway.send('deepseek-v4-flash', prefix);
    assert.equal(response.status, 200, `${prefix} ${style}`); await response.text();
    assert.equal(response.headers.get('x-switch-alias'), 'aos');
    assert.deepEqual(calls.map(call => call.alias), Array(6).fill('aos'));
    assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000]);
    for (const call of calls) {
      assert.equal(call.payload.model, 'deepseek-v4-flash'); assert.deepEqual(call.payload.messages, gateway.messages); assert.deepEqual(call.payload.tools, gateway.tools);
    }
    assert.equal(readState(gateway.root).active, 'aos');
    await (await gateway.send('deepseek-v4-flash', prefix)).text();
    assert.equal(calls.at(-1).alias, 'aos');
  }
});

test('Claude gives every backup its own five-retry budget and retains bounded, redacted failure details', async t => {
  const calls = [], waits = [];
  const gateway = await setup(t, async (url, options) => {
    if (!options.body) return Response.json({ data: [{ id: 'deepseek-v4-flash' }] });
    const alias = new URL(url).hostname.split('.')[0]; calls.push(alias);
    return Response.json({ error: { message: `Service unavailable ${alias}-secret` } }, { status: 503, headers: { 'retry-after': '3' } });
  }, { wait: async ms => waits.push(ms) });
  for (const alias of ['aos', 'elias']) addProvider(alias, provider(alias), gateway.root);
  const response = await gateway.send('deepseek-v4-flash');
  assert.equal(response.status, 503); const result = await response.json();
  assert.deepEqual(calls, ['aos', 'elias'].flatMap(alias => Array(6).fill(alias)));
  assert.deepEqual(waits, Array(2).fill([3000, 3000, 4000, 8000, 16000]).flat());
  assert.deepEqual(result.error.attempts.map(attempt => attempt.provider), ['aos', 'elias']);
  assert.doesNotMatch(JSON.stringify(result), /aos-secret|elias-secret/);
  assert.equal(readState(gateway.root).active, 'aos', 'failed backups cannot become selected');
});

test('Claude honors manual changes before and during transient backoff, and cancels disconnected clients', async t => {
  for (const duringWait of [false, true]) {
    const calls = [], waits = [];
    const gateway = await setup(t, async (url, options) => {
      if (!options.body) return Response.json({ data: [{ id: 'deepseek-v4-flash' }] });
      const alias = new URL(url).hostname.split('.')[0]; calls.push(alias);
      if (alias === 'aos') { if (!duringWait) activate('elias', gateway.root); return new Response('', { status: 503 }); }
      return message('deepseek-v4-flash');
    }, { wait: async ms => { waits.push(ms); activate('elias', gateway.root); } });
    for (const alias of ['aos', 'second', 'elias']) addProvider(alias, provider(alias), gateway.root);
    const response = await gateway.send('deepseek-v4-flash'); assert.equal(response.status, 200); await response.text();
    assert.deepEqual(calls, ['aos', 'elias']); assert.deepEqual(waits, duringWait ? [1000] : []);
    assert.equal(readState(gateway.root).reason, 'manual');
  }
  let started, cancelled; const waiting = new Promise(resolve => { started = resolve; }), stopped = new Promise(resolve => { cancelled = resolve; }); let calls = 0;
  const gateway = await setup(t, async () => { calls++; return new Response('', { status: 503 }); }, {
    wait: async (_ms, signal) => { started(); await once(signal, 'abort'); cancelled(); },
  });
  addProvider('aos', provider('aos'), gateway.root);
  const abort = new AbortController();
  const pending = fetch(gateway.base + '/claude/v1/messages', { method: 'POST', headers: gateway.headers, body: JSON.stringify({ model: 'deepseek-v4-flash', messages: gateway.messages }), signal: abort.signal });
  const rejected = assert.rejects(pending, /abort/i); await waiting; abort.abort(); await rejected; await stopped;
  assert.equal(calls, 1);
});

test('Claude never shortens long Retry-After values or retries explicit quota, authentication and policy rejections', async t => {
  for (const [status, detail, retryAfter, succeeds] of [
    [503, { type: 'server_error' }, '120', true], [503, { code: 'insufficient_quota' }, null, true],
    [401, { type: 'authentication_error' }, null, true], [429, { type: 'rate_limit_error' }, null, true],
    [503, { message: 'content_policy_violation' }, null, false],
  ]) {
    const calls = [];
    const gateway = await setup(t, async (url, options) => {
      if (!options.body) return Response.json({ data: [{ id: 'deepseek-v4-flash' }] });
      const alias = new URL(url).hostname.split('.')[0]; calls.push(alias);
      return alias === 'aos' ? Response.json({ error: detail }, { status, headers: retryAfter ? { 'retry-after': retryAfter } : {} }) : message('deepseek-v4-flash');
    }, { wait: async () => assert.fail('must not delay or shorten Retry-After') });
    for (const alias of ['aos', 'elias']) addProvider(alias, provider(alias), gateway.root);
    const response = await gateway.send('deepseek-v4-flash'); await response.text();
    assert.equal(response.status, succeeds ? 200 : status); assert.deepEqual(calls, succeeds ? ['aos', 'elias'] : ['aos']);
  }
});

test('model cooldowns are independent and a failed fallback cannot become the active provider', async t => {
  const calls = []; let time = 0;
  const gateway = await setup(t, async (url, options) => {
    if (!options.body) return Response.json({ data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }] });
    const model = JSON.parse(options.body).model, alias = new URL(url).hostname.split('.')[0]; calls.push({ alias, model });
    if (alias === 'a' && model.endsWith('flash')) return new Response('', { status: 429 });
    if (alias === 'b') return Response.json({ error: { message: 'invalid key b-secret' } }, { status: 401 });
    return message(model);
  }, { now: () => time });
  for (const alias of ['a', 'b']) addProvider(alias, provider(alias), gateway.root);
  const catalog = await gateway.catalog();
  let response = await gateway.send(catalog.data[1].id);
  assert.equal(response.status, 502); const error = await response.json();
  assert.deepEqual(error.error.attempts.map(item => item.status), [429, 401]);
  assert.match(error.error.message, /a \(HTTP 429/); assert.match(error.error.message, /b \(HTTP 401/);
  assert.ok(!JSON.stringify(error).includes('b-secret')); assert.equal(readState(gateway.root).active, 'a');
  response = await gateway.send(catalog.data[0].id); assert.equal(response.status, 200); await response.text();
  assert.deepEqual(calls.at(-1), { alias: 'a', model: 'deepseek-v4-pro' }, 'Flash rejection cannot disable Pro');
  time += 61000;
  response = await gateway.send(catalog.data[1].id); await response.text();
  assert.deepEqual(calls.slice(-2).map(item => item.alias), ['a', 'b'], 'expired cooldowns allow retries');
  const invalid = await fetch(gateway.base + '/claude-desktop/v1/models', { headers: { authorization: 'Bearer wrong' } });
  assert.equal(invalid.status, 401, 'only invalid local credentials receive an authentication rejection');
});

test('a model offered only by another provider routes there without substituting its main mapping', async t => {
  const calls = [];
  const gateway = await setup(t, async (url, options) => {
    if (!options.body) return Response.json({ data: [{ id: url.includes('a.test') ? 'deepseek-v4-pro' : 'deepseek-v4-flash' }] });
    const payload = JSON.parse(options.body); calls.push({ url, payload }); return message(payload.model);
  });
  addProvider('a', provider('a'), gateway.root);
  addProvider('b', { ...provider('b'), claudeModels: { default: 'different-default' } }, gateway.root);
  const catalog = await gateway.catalog(), selected = catalog.data.find(item => item.display_name === 'deepseek-v4-flash');
  const response = await gateway.send(selected.id); assert.equal(response.status, 200); await response.text();
  assert.equal(calls.length, 1); assert.equal(calls[0].payload.model, 'deepseek-v4-flash'); assert.match(calls[0].url, /b.test/);
  assert.deepEqual(calls[0].payload.messages, gateway.messages);
});

test('content policy remains final and accepted output is never replayed', async t => {
  for (const accepted of [false, true]) {
    let calls = 0;
    const gateway = await setup(t, async (_url, options) => {
      if (!options.body) return Response.json({ data: [{ id: 'deepseek-v4-flash' }] });
      calls++;
      return accepted ? new Response('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"first"}}\n\nevent: error\ndata: {"type":"error","error":{"type":"rate_limit_error"}}\n\n', { headers: { 'content-type': 'text/event-stream' } }) : Response.json({ error: { message: 'content_policy_violation' } }, { status: 403 });
    });
    for (const alias of ['a', 'b']) addProvider(alias, provider(alias), gateway.root);
    const selected = (await gateway.catalog()).data[0], response = await gateway.send(selected.id);
    assert.equal(response.status, accepted ? 200 : 403); await response.text(); assert.equal(calls, 1);
  }
});

test('a manual provider choice during a fallback response cannot be overwritten by its completion', async t => {
  let root;
  const gateway = await setup(t, async (url, options) => {
    if (!options.body) return Response.json({ data: [{ id: 'deepseek-v4-flash' }] });
    if (url.includes('a.test')) return new Response('', { status: 429 });
    activate('c', root);
    return message(JSON.parse(options.body).model);
  });
  root = gateway.root;
  for (const alias of ['a', 'b', 'c']) addProvider(alias, provider(alias), root);
  const selected = (await gateway.catalog()).data[0], response = await gateway.send(selected.id);
  assert.equal(response.status, 200); await response.text();
  assert.equal(response.headers.get('x-switch-alias'), 'b');
  assert.equal(readState(root).active, 'c', 'the later manual selection wins');
});
