import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { init, atomic, addProvider, editProvider, removeProvider, activate, readState } from '../src/store.js';
import { createClaudeHandler } from './reference/claude-proxy.js';
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

test('Claude tries a backup for an opaque HTTP 400 and preserves validation and policy rejections', async t => {
  for (const mode of ['http', 'startup', 'validation', 'policy', 'late']) {
    const calls=[];
    const gateway=await setup(t,async(url,options)=>{
      if(!options.body)return Response.json({data:[{id:'claude-sonnet-test'}]});
      const alias=new URL(url).hostname[0];calls.push({alias,body:JSON.parse(options.body)});
      if(alias==='b')return message('claude-sonnet-test');
      if(mode==='http')return new Response('',{status:400});
      if(mode==='validation')return Response.json({error:{code:'context_length_exceeded'}},{status:400});
      if(mode==='policy')return Response.json({error:{code:'content_policy_violation'}},{status:400});
      const prefix=mode==='late'?'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"accepted"}}\n\n':'';
      return new Response(prefix+'event: error\ndata: {"type":"error","error":{"type":"invalid_request_error","message":"Bad Request"}}\n\n',{headers:{'content-type':'text/event-stream'}});
    });
    for(const alias of ['a','b'])addProvider(alias,provider(alias),gateway.root);
    const response=await gateway.send('claude-sonnet-test','/claude');await response.text();
    const fallback=['http','startup'].includes(mode);
    assert.deepEqual(calls.map(row=>row.alias),fallback?['a','b']:['a'],mode);
    if(fallback){assert.equal(response.status,200);assert.deepEqual(calls[0].body,calls[1].body);}
  }
});

test('Claude desktop and editor discovery retain their own protocol headers, model capabilities and cache entries', async t => {
  const reads = [];
  const gateway = await setup(t, async (_url, options) => {
    reads.push(options.headers);
    const desktop = options.headers['user-agent'] === 'claude-desktop/1.0';
    return Response.json({ data: [{ id: 'claude-sonnet-test', display_name: desktop ? 'Desktop model' : 'Editor model',
      capabilities: { effort: { supported_efforts: desktop ? ['low', 'high'] : ['low', 'high', 'max'] } }, max_input_tokens: desktop ? 100000 : 200000 }] });
  });
  addProvider('api', provider('api'), gateway.root);
  for (const desktop of [true, false, true]) {
    const prefix = desktop ? '/claude-desktop' : '/claude';
    const headers = { ...gateway.headers, 'user-agent': desktop ? 'claude-desktop/1.0' : 'claude-cli/2.0', 'anthropic-version': desktop ? '2023-06-01' : '2024-01-01', 'anthropic-beta': desktop ? 'desktop-fixture' : 'editor-fixture' };
    const response = await fetch(gateway.base + prefix + '/v1/models', { headers });
    const result = await response.json(); assert.equal(response.status, 200);
    assert.equal(result.data[0].display_name, desktop ? 'Desktop model' : 'Editor model');
    assert.deepEqual(result.data[0].capabilities.effort.supported_efforts, desktop ? ['low', 'high'] : ['low', 'high', 'max']);
    assert.equal(result.data[0].max_input_tokens, desktop ? 100000 : 200000);
    assert.equal(reads.at(-1)['anthropic-beta'], headers['anthropic-beta']);
    assert.equal(reads.at(-1).authorization, 'Bearer api-secret', 'never forward the local gateway token');
  }
});

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
  assert.ok(first.data.every(item => item.description.startsWith('fluid · ')));
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

test('unavailable models fail over on HTTP and startup SSE without retrying transient failures', async t => {
  for (const style of ['http', 'sse']) {
    const calls = [];
    const gateway = await setup(t, async (url, options) => {
      if (!options.body) return Response.json({ data: [{ id: 'deepseek-v4-flash' }] });
      const model = JSON.parse(options.body).model; calls.push({ url, model });
      if (url.includes('a.test')) {
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

test('Claude CLI and Desktop leave transient HTTP, connection and startup SSE retries to the client', async t => {
  for (const prefix of ['/claude', '/claude-desktop']) for (const style of [500, 502, 503, 504, 529, 'network', 'sse', 'disconnect']) {
    const calls = [];
    const gateway = await setup(t, async (url, options) => {
      if (!options.body) return Response.json({ data: [{ id: 'deepseek-v4-flash' }] });
      calls.push({ alias: new URL(url).hostname.split('.')[0], payload: JSON.parse(options.body) });
      if (calls.length > 5) return message(calls.at(-1).payload.model);
      if (style === 'network') throw new TypeError('fetch failed');
      const preamble = 'event: message_start\ndata: {"type":"message_start","message":{"content":[]}}\n\n';
      if (style === 'disconnect') return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(preamble)); }, pull(controller) { controller.error(new TypeError('connection closed')); } }), { headers: { 'content-type': 'text/event-stream' } });
      if (style === 'sse') return new Response(preamble + 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
      return new Response('Service Unavailable', { status: style });
    });
    for (const alias of ['aos', 'elias']) addProvider(alias, provider(alias), gateway.root);
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await gateway.send('deepseek-v4-flash', prefix); await response.text();
      assert.equal(response.status, style === 'sse' ? 503 : typeof style === 'number' ? style : 502);
      assert.equal(calls.length, attempt + 1); assert.equal(readState(gateway.root).active, 'aos');
    }
    const response = await gateway.send('deepseek-v4-flash', prefix);
    assert.equal(response.status, 200, `${prefix} ${style}`); await response.text();
    assert.equal(response.headers.get('x-switch-alias'), 'aos');
    assert.deepEqual(calls.map(call => call.alias), Array(6).fill('aos'));
    for (const call of calls) {
      assert.equal(call.payload.model, 'deepseek-v4-flash'); assert.deepEqual(call.payload.messages, gateway.messages); assert.deepEqual(call.payload.tools, gateway.tools);
    }
    assert.equal(readState(gateway.root).active, 'aos'); assert.equal(readState(gateway.root).lastFailover, undefined);
  }
});

test('persistent Claude outages preserve Retry-After and do not walk backups or duplicate attempts', async t => {
  const calls = [];
  const gateway = await setup(t, async (url, options) => {
    if (!options.body) return Response.json({ data: [{ id: 'deepseek-v4-flash' }] });
    const alias = new URL(url).hostname.split('.')[0]; calls.push(alias);
    return Response.json({ error: { message: `Service unavailable ${alias}-secret` } }, { status: 503, headers: { 'retry-after': '120' } });
  });
  for (const alias of ['aos', 'elias']) addProvider(alias, provider(alias), gateway.root);
  const response = await gateway.send('deepseek-v4-flash');
  assert.equal(response.status, 503); assert.equal(response.headers.get('retry-after'), '120');
  const result = await response.json();
  assert.deepEqual(calls, ['aos']); assert.deepEqual(result.error.attempts.map(attempt => attempt.provider), ['aos']);
  assert.doesNotMatch(JSON.stringify(result), /aos-secret|elias-secret/);
  assert.equal(readState(gateway.root).active, 'aos');
});

test('Claude manual changes apply to the next client retry without replaying a transient failure', async t => {
  const calls = [];
  const gateway = await setup(t, async (url, options) => {
    if (!options.body) return Response.json({ data: [{ id: 'deepseek-v4-flash' }] });
    const alias = new URL(url).hostname.split('.')[0]; calls.push(alias);
    if (alias === 'aos') { activate('elias', gateway.root); return new Response('', { status: 503 }); }
    return message('deepseek-v4-flash');
  });
  for (const alias of ['aos', 'second', 'elias']) addProvider(alias, provider(alias), gateway.root);
  const response = await gateway.send('deepseek-v4-flash'); assert.equal(response.status, 503); await response.text();
  assert.deepEqual(calls, ['aos']);
  const next = await gateway.send('deepseek-v4-flash'); assert.equal(next.status, 200); await next.text();
  assert.deepEqual(calls, ['aos', 'elias']); assert.equal(readState(gateway.root).reason, 'manual');
});

test('Claude explicit quota and authentication errors still fail over while policy rejections remain final', async t => {
  for (const [status, detail, succeeds] of [
    [503, { code: 'insufficient_quota' }, true], [401, { type: 'authentication_error' }, true],
    [429, { type: 'rate_limit_error' }, true], [503, { message: 'content_policy_violation' }, false],
  ]) {
    const calls = [];
    const gateway = await setup(t, async (url, options) => {
      if (!options.body) return Response.json({ data: [{ id: 'deepseek-v4-flash' }] });
      const alias = new URL(url).hostname.split('.')[0]; calls.push(alias);
      return alias === 'aos' ? Response.json({ error: detail }, { status }) : message('deepseek-v4-flash');
    });
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
