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
  const server = http.createServer(createClaudeHandler({ root, fetchImpl, ...extra }));
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

test('gateway catalog is a stable deduplicated union, tolerates unavailable providers and refreshes edits', async t => {
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
  assert.deepEqual(raw.data.map(item => item.id), ['deepseek-v4-pro', 'deepseek-v4-flash', 'claude-sonnet-test']);
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
    assert.deepEqual(calls.map(call => call.model), ['deepseek-v4-flash', 'deepseek-v4-flash'], style);
    assert.equal(readState(gateway.root).active, 'b');
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
