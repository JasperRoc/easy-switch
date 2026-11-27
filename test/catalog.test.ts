import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomic, accountAuth } from '../src/store.js';
import { codexModels, codexModelMetadata, discoverModels, createCodexCatalog } from '../src/catalog.js';


const nativeModel = (id, priority, efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], hidden = false) => ({
  id, label: id === 'gpt-6.1-sol' ? 'GPT-6.1-Sol' : id, efforts, defaultEffort: 'low',
  metadata: { priority, visibility: hidden ? 'hide' : 'list', default_reasoning_level: 'low', supported_reasoning_levels: efforts.map(effort => ({ effort, description: effort })) },
});
const clientMetadata = async () => [nativeModel('gpt-6.1-sol', 0), nativeModel('gpt-6-astra', 1), nativeModel('gpt-6-sol', 2),
  nativeModel('gpt-6-luna', 3, ['low', 'medium', 'high', 'xhigh', 'max']), nativeModel('gpt-5.6-sol', 4), nativeModel('gpt-6.1-terra', 5),
  nativeModel('gpt-5.6-terra', 6), nativeModel('gpt-5.6-luna', 7), nativeModel('codex-auto-review', 8, [], true)];

function catalogRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-catalog-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const entry = { model: 'model-a', displayName: 'Model A', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] };
function fakeServer(mode = 'success') {
  const requests = []; let directory;
  const spawnImpl = (_binary, _args, options) => {
    directory = options.env.CODEX_HOME;
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, encoding, done) {
      const request = JSON.parse(chunk.toString()); requests.push(request);
      if (mode !== 'timeout' && request.id != null) queueMicrotask(() => {
        const result = request.method === 'initialize' ? {} : request.params.cursor ? { data: [{ ...entry, model: 'model-b' }], nextCursor: null } : { data: [entry], nextCursor: 'page-2' };
        child.stdout.write(JSON.stringify({ id: request.id, ...(mode === 'error' ? { error: { message: 'SECRET' } } : { result }) }) + '\n');
      });
      done();
    } });
    child.kill = () => { child.stdout.end(); child.emit('close', 0); return true; };
    return child;
  };
  return { spawnImpl, requests, directory: () => directory };
}
test('Codex model discovery is isolated, paginated, and creates no user threads', async () => {
  const fake = fakeServer();
  const result = await codexModels({ spawnImpl: fake.spawnImpl });
  assert.deepEqual(result.map(model => model.id), ['model-a', 'model-b']);
  assert.deepEqual(result[0].efforts, ['low', 'high']);
  assert.ok(fake.requests.every(request => !request.method.startsWith('thread/')));
  assert.equal(fs.existsSync(fake.directory()), false);
});
test('catalog timeout and protocol errors clean up the isolated process and do not echo diagnostics', async () => {
  for (const mode of ['timeout', 'error']) {
    const fake = fakeServer(mode);
    await assert.rejects(codexModels({ spawnImpl: fake.spawnImpl, timeoutMs: 10 }), error => !error.message.includes('SECRET'));
    assert.equal(fs.existsSync(fake.directory()), false);
  }
});
test('cancelled background credential refresh terminates its Codex helper and removes the isolated home', async () => {
  const fake = fakeServer('timeout'), abort = new AbortController();
  const pending = codexModels({ spawnImpl: fake.spawnImpl, signal: abort.signal });
  assert.ok(fs.existsSync(fake.directory())); abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(fs.existsSync(fake.directory()), false);
  await assert.rejects(codexModels({ spawnImpl: () => assert.fail('already aborted'), signal: abort.signal }), { name: 'AbortError' });
});
test('API models retain provider-only IDs; unavailable discovery has an explicit notice', async () => {
  const catalogImpl = async () => [{ id: 'model-a', efforts: ['low'] }, { id: 'model-b', efforts: ['high'] }];
  const provider = { type: 'api', baseUrl: 'https://example.com/v1', apiKey: 'SECRET' };
  const result = await discoverModels(provider, '/unused', { catalogImpl, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://example.com/v1/models'); assert.equal(options.headers.authorization, 'Bearer SECRET'); assert.equal(options.redirect, 'error');
    return Response.json({ data: [{ id: 'model-b' }, { id: 'unrecognized' }] });
  } });
  assert.deepEqual(result.models.map(model => model.id), ['model-b', 'unrecognized']);
  assert.deepEqual(result.models[1].efforts, []);
  await assert.rejects(discoverModels(provider, '/unused', { catalogImpl, fetchImpl: async () => new Response('SECRET', { status: 401 }) }), error => /无法读取/.test(error.message) && !error.message.includes('SECRET'));
});

test('subscription discovery reads only the authenticated live catalog and retains native capabilities', async t => {
  const accountHome = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-live-catalog-'));
  t.after(() => fs.rmSync(accountHome, { recursive: true, force: true }));
  atomic(path.join(accountHome, 'auth.json'), { tokens: { access_token: 'private-subscription', account_id: 'subscription-id' } });
  const metadata = { slug: 'subscription-only', display_name: 'Subscription model', supported_reasoning_levels: [{ effort: 'high' }], context_window: 120000 };
  const provider = { type: 'account', accountHome };
  const result = await discoverModels(provider, '/unused', { clientVersion: '0.165.0', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/models?client_version=0.165.0');
    assert.equal(options.headers.authorization, 'Bearer private-subscription');
    assert.equal(options.headers['ChatGPT-Account-ID'], 'subscription-id');
    return Response.json({ models: [metadata] });
  } });
  assert.deepEqual(result.models.map(model => model.id), ['subscription-only']);
  assert.deepEqual(result.models[0].metadata, { ...metadata, supported_reasoning_levels: [{ effort: 'high', description: 'high' }], default_reasoning_level: 'high' });
  await assert.rejects(discoverModels(provider, '/unused', { clientVersion: '0.165.0', fetchImpl: async () => new Response('', { status: 401 }) }), /live Codex model catalog/);
});

test('API discovery works without Codex metadata and reports empty catalogs', async () => {
  const provider = { type: 'api', baseUrl: 'https://example.com/v1', apiKey: 'fixture' };
  const catalogImpl = async () => { throw new Error('native catalog unavailable'); };
  const result = await discoverModels(provider, '/unused', { catalogImpl, fetchImpl: async () => Response.json({ data: [{ id: 'provider-model' }, { id: 'provider-model' }, null, {}] }) });
  assert.deepEqual(result.models.map(model => model.id), ['provider-model']);
  const empty = await discoverModels(provider, '/unused', { catalogImpl, fetchImpl: async () => Response.json({ data: [] }) });
  assert.deepEqual(empty.models, []); assert.match(empty.notice, /空目录/);
  await assert.rejects(discoverModels(provider, '/unused', { catalogImpl, fetchImpl: async () => new Response('', { status: 403 }) }), /无法读取/);
});

test('subscription discovery isolates credentials and preserves refresh without overwriting a concurrent sign-in', async t => {
  const accountHome = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-model-account-'));
  t.after(() => fs.rmSync(accountHome, { recursive: true, force: true }));
  const provider = { type: 'account', accountHome };
  const original = { tokens: { access_token: 'fixture-original', account_id: 'fixture' } };
  const refreshed = { tokens: { access_token: 'fixture-refreshed', account_id: 'fixture' } };
  const newer = { tokens: { access_token: 'fixture-concurrent-login', account_id: 'fixture' } };
  for (const concurrent of [false, true]) {
    atomic(path.join(accountHome, 'auth.json'), original);
    const fake = fakeServer();
    await codexModels({ provider, spawnImpl: (binary, args, options) => {
      const temporary = options.env.CODEX_HOME;
      assert.notEqual(temporary, accountHome);
      assert.deepEqual(accountAuth({ accountHome: temporary }), original);
      assert.equal(fs.readFileSync(path.join(temporary, 'config.toml'), 'utf8').includes('model_provider="catalog"'), false);
      atomic(path.join(temporary, 'auth.json'), refreshed);
      if (concurrent) atomic(path.join(accountHome, 'auth.json'), newer);
      return fake.spawnImpl(binary, args, options);
    } });
    assert.deepEqual(accountAuth(provider), concurrent ? newer : refreshed);
    assert.equal(fs.existsSync(fake.directory()), false);
  }
});

test('API catalogs use official Codex ordering and reasoning presets without adding unavailable models', async () => {
  const provider = { type: 'api', baseUrl: 'https://example.com/v1', apiKey: 'fixture' };
  const ids = ['vendor-10', 'gpt-6-luna', 'gpt-6.1-sol', 'vendor-2'];
  const result = await discoverModels(provider, '/unused', { metadataImpl: clientMetadata, fetchImpl: async () => Response.json({ data: ids.map(id => ({ id })) }) });
  assert.deepEqual(result.models.map(model => model.id), ['gpt-6.1-sol', 'gpt-6-luna', 'vendor-2', 'vendor-10']);
  assert.equal(result.models[0].label, 'GPT-6.1-Sol');
  assert.deepEqual(result.models[0].efforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.equal(result.models[0].defaultEffort, 'low');
  assert.deepEqual(result.models[1].efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(result.models[2].efforts, []);
});

test('API-only union retains official effort choices and ignores provider order when sorting models', async t => {
  const providers = {
    first: { type: 'api', baseUrl: 'https://first.example/v1', apiKey: 'fixture' },
    second: { type: 'api', baseUrl: 'https://second.example/v1', apiKey: 'fixture' },
  };
  const catalog = createCodexCatalog({ root: catalogRoot(t), metadataImpl: clientMetadata, fetchImpl: async url => Response.json({ data: (url.includes('first')
    ? ['vendor-10', 'gpt-6-luna', 'codex-auto-review'] : ['vendor-2', 'gpt-6.1-sol']).map(id => ({ id })) }) });
  for (const order of [['first', 'second'], ['second', 'first']]) {
    const result = await catalog.union({ providers, order }, '0.165.0', new AbortController().signal);
    assert.deepEqual(result.models.map(model => model.slug), ['gpt-6.1-sol', 'gpt-6-luna', 'vendor-2', 'vendor-10']);
    assert.deepEqual(result.models[0].supported_reasoning_levels.map(level => level.effort), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    assert.equal(result.models[0].default_reasoning_level, 'low');
    assert.deepEqual(result.models[2].supported_reasoning_levels, []);
    assert.ok(!result.models.some(model => model.slug === 'gpt-5.5'), 'bundled metadata must not add model availability');
  }
});

test('partial provider metadata cannot poison the model union or known reasoning choices', async t => {
  const providers = Object.fromEntries(['partial', 'healthy', 'offline'].map(alias => [alias, {
    type: 'api', baseUrl: `https://${alias}.example/v1`, apiKey: 'fixture',
  }]));
  const catalog = createCodexCatalog({ root: catalogRoot(t), metadataImpl: clientMetadata, fetchImpl: async url => {
    if (url.includes('offline')) return new Response('', { status: 503 });
    return Response.json({ data: url.includes('healthy') ? [{ id: 'healthy-only' }, { id: 'gpt-6.1-sol' }] : [
      { id: 'gpt-6.1-sol', supported_reasoning_levels: null, shell_type: null, visibility: null, support_verbosity: null },
      { id: 'partial-only', supported_reasoning_levels: [{ effort: 'high' }, null, { effort: 'high' }, {}], default_reasoning_level: 'invalid' },
      { id: 'string-efforts', supported_reasoning_levels: ['low', 'high'], experimental_supported_tools: null, truncation_policy: null },
      { id: 'gpt-6-luna', supported_reasoning_levels: [], default_reasoning_level: null },
      { id: 'gpt-image-2' },
    ] });
  } });
  const result = await catalog.union({ providers, order: ['partial', 'healthy', 'offline'] }, '0.171.0', new AbortController().signal);
  assert.deepEqual(result.models.map(model => model.slug), ['gpt-6.1-sol', 'gpt-6-luna', 'healthy-only', 'partial-only', 'string-efforts']);
  assert.deepEqual(result.models[0].supported_reasoning_levels.map(level => level.effort), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.equal(result.models[0].shell_type, 'shell_command');
  assert.equal(result.models[0].visibility, 'list');
  assert.equal(result.models[0].support_verbosity, false);
  assert.deepEqual(result.models[1].supported_reasoning_levels, []);
  assert.equal(result.models[1].default_reasoning_level, null);
  assert.deepEqual(result.models[3].supported_reasoning_levels, [{ effort: 'high', description: 'high' }]);
  assert.equal(result.models[3].default_reasoning_level, 'high');
  assert.deepEqual(result.models[4].supported_reasoning_levels, [{ effort: 'low', description: 'low' }, { effort: 'high', description: 'high' }]);
  assert.deepEqual(result.models[4].experimental_supported_tools, []);
  assert.deepEqual(result.models[4].truncation_policy, { mode: 'tokens', limit: 10000 });
});

test('native variant ordering and live subscription reasoning presets coexist, including explicit empty choices', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-catalog-priority-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  atomic(path.join(root, 'auth.json'), { tokens: { access_token: 'fixture', account_id: 'fixture' } });
  const providers = {
    api: { type: 'api', baseUrl: 'https://example.com/v1', apiKey: 'fixture' },
    account: { type: 'account', accountHome: root },
  };
  const catalog = createCodexCatalog({ root, metadataImpl: clientMetadata, fetchImpl: async url => url.includes('chatgpt.com') ? Response.json({ models: [
    { slug: 'gpt-6-sol', display_name: 'Live Sol', priority: 20, supported_reasoning_levels: [], default_reasoning_level: null },
    { slug: 'gpt-6-luna', display_name: 'Live Luna', priority: 0, supported_reasoning_levels: [{ effort: 'high', description: 'Live high' }], default_reasoning_level: 'high', context_window: 100000 },
  ] }) : Response.json({ data: [{ id: 'gpt-6-sol' }, { id: 'gpt-6-luna' }] }) });
  const result = await catalog.union({ providers, order: ['api', 'account'] }, '0.165.0', new AbortController().signal);
  assert.deepEqual(result.models.map(model => model.slug), ['gpt-6-sol', 'gpt-6-luna']);
  assert.equal(result.models[1].default_reasoning_level, 'high');
  assert.deepEqual(result.models[1].supported_reasoning_levels, [{ effort: 'high', description: 'Live high' }]);
  assert.equal(result.models[1].context_window, 100000);
  assert.deepEqual(result.models[0].supported_reasoning_levels, []);
  assert.equal(result.models[0].default_reasoning_level, null);
});

test('custom catalog labels retain official reasoning defaults when provider discovery fails', async t => {
  const providers = { api: { type: 'api', baseUrl: 'https://example.com/v1', apiKey: 'fixture', modelCatalog: [
    { id: 'vendor-model', label: 'My model' }, { id: 'gpt-6.1-sol', label: 'My Sol' },
  ] } };
  const catalog = createCodexCatalog({ root: catalogRoot(t), metadataImpl: clientMetadata, fetchImpl: async () => new Response('', { status: 403 }) });
  const result = await catalog.union({ providers, order: ['api'] }, '0.165.0', new AbortController().signal);
  assert.equal(result.models[0].slug, 'gpt-6.1-sol');
  assert.equal(result.models[0].display_name, 'My Sol');
  assert.equal(result.models[0].default_reasoning_level, 'low');
  assert.ok(result.models[0].supported_reasoning_levels.some(level => level.effort === 'high'));
  assert.equal(result.models[1].display_name, 'My model');
});


test('Codex keeps model series together, follows native variant order and removes image-only models', async t => {
  const ids = ['gpt-5.6-luna', 'gpt-image-2', 'gpt-6-luna', 'gpt-6.1-terra', 'gpt-5.6-terra', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-5.6-sol', 'gpt-image-2.5-flare', 'dall-e-3'];
  const expected = ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
  const provider = { type: 'api', baseUrl: 'https://example.com/v1', apiKey: 'fixture' };
  const fetchImpl = async () => Response.json({ data: ids.map(id => ({ id })) });
  const result = await discoverModels(provider, '/unused', { metadataImpl: clientMetadata, fetchImpl });
  assert.deepEqual(result.models.map(model => model.id), expected);
  const catalog = createCodexCatalog({ root: catalogRoot(t), metadataImpl: clientMetadata, fetchImpl });
  const union = await catalog.union({ providers: { api: provider }, order: ['api'] }, '0.165.0', new AbortController().signal);
  assert.deepEqual(union.models.map(model => model.slug), expected);
  assert.ok(union.models[0].supported_reasoning_levels.some(level => level.effort === 'high'));
});

test('Codex never substitutes client models for an empty or failed provider directory', async t => {
  for (const response of [() => Response.json({ data: [] }), () => new Response('', { status: 403 })]) {
    let reads = 0;
    const catalog = createCodexCatalog({ root: catalogRoot(t), metadataImpl: async () => { reads++; return clientMetadata(); }, fetchImpl: async () => response() });
    const provider = { type: 'api', baseUrl: 'https://example.com/v1', apiKey: 'fixture' };
    const result = await catalog.union({ providers: { api: provider }, order: ['api'] }, '0.165.0', new AbortController().signal);
    assert.deepEqual(result.models, []);
    assert.equal(reads, 0, 'an empty directory does not start a metadata helper');
  }
});

test('Codex catalog filtering also applies to saved image IDs and metadata-only image routes', async t => {
  const provider = { type: 'api', baseUrl: 'https://example.com/v1', apiKey: 'fixture', modelCatalog: [{ id: 'gpt-image-2', label: 'Pictures' }, { id: 'gpt-6-sol', label: 'My Sol' }] };
  const catalog = createCodexCatalog({ root: catalogRoot(t), metadataImpl: clientMetadata, fetchImpl: async () => Response.json({ data: [] }) });
  const result = await catalog.union({ providers: { api: provider }, order: ['api'] }, '0.165.0', new AbortController().signal);
  assert.deepEqual(result.models.map(model => model.slug), ['gpt-6-sol']);
  assert.equal(result.models[0].display_name, 'My Sol');
});


test('Codex filters image-only metadata even when an API uses an unrelated image model ID', async () => {
  const provider = { type: 'api', baseUrl: 'https://example.com/v1', apiKey: 'fixture' };
  const result = await discoverModels(provider, '/unused', { metadataImpl: clientMetadata, fetchImpl: async () => Response.json({ data: [
    { id: 'art-model', output_modalities: ['image'] }, { id: 'gpt-6-sol', output_modalities: ['text', 'image'] },
  ] }) });
  assert.deepEqual(result.models.map(model => model.id), ['gpt-6-sol']);
});


test('subscription model directories use series grouping and native variant order while retaining live effort', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-sub-series-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  atomic(path.join(root, 'auth.json'), { tokens: { access_token: 'fixture', account_id: 'fixture' } });
  const provider = { type: 'account', accountHome: root };
  const ids = ['gpt-6-luna', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-image-2'];
  const result = await discoverModels(provider, root, { clientVersion: '0.165.0', metadataImpl: clientMetadata, fetchImpl: async () => Response.json({ models: ids.map((slug, priority) => ({
    slug, priority, display_name: slug, supported_reasoning_levels: [{ effort: 'high', description: 'Live high' }], default_reasoning_level: 'high',
  })) }) });
  assert.deepEqual(result.models.map(model => model.id), ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']);
  assert.ok(result.models.every(model => model.defaultEffort === 'high'));
});

test('late subscription discovery for one Codex version cannot replace another version’s catalog', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-versioned-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accountHome = path.join(root, 'account'), provider = { type: 'account', accountHome };
  atomic(path.join(accountHome, 'auth.json'), { tokens: { access_token: 'fixture', account_id: 'fixture' } });
  const state = { providers: { account: provider } };
  const signal = new AbortController().signal;
  const old = '0.165.0', current = '0.171.0', model = 'gpt-6.2-sol';
  let finishOld;
  const catalog = createCodexCatalog({ root, metadataImpl: async () => [], fetchImpl: async url => {
    if (new URL(url).searchParams.get('client_version') === old) return new Promise(resolve => { finishOld = resolve; });
    return Response.json({ models: [{ slug: model }] });
  } });
  const pending = catalog.union(state, old, signal);
  await catalog.union(state, current, signal);
  finishOld(Response.json({ models: [{ slug: 'gpt-6.1-sol' }] }));
  await pending;
  assert.equal(catalog.supports('account', provider, model, old), false);
  assert.equal(catalog.supports('account', provider, model, current), true);
  assert.equal(catalog.supports('account', provider, 'absent', current), false);
  assert.equal(catalog.supports('account', provider, model), true, 'an unknown client version cannot exclude a subscription');

  const restarted = createCodexCatalog({ root, fetchImpl: async () => { throw new Error('unavailable'); } });
  for (const [version, slug] of [[old, 'gpt-6.1-sol'], [current, model]])
    assert.deepEqual((await restarted.union(state, version, signal)).models.map(item => item.slug), [slug]);
  assert.equal(restarted.supports('account', provider, 'absent', old), true, 'only live catalogs filter inference');
});

test('a saved provider catalog makes later launches independent of slow upstream discovery and never stores API keys', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'switch-catalog-startup-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const providers={api:{type:'api',baseUrl:'https://models.example/v1',apiKey:'PRIVATE_API_KEY'}};
  const state={providers,order:['api']};
  const initial=createCodexCatalog({root,metadataImpl:clientMetadata,fetchImpl:async()=>Response.json({data:[{id:'gpt-6.1-sol'}]})});
  await initial.union(state,'0.165.0',new AbortController().signal);
  const saved=fs.readFileSync(path.join(root,'model-catalog-cache.json'),'utf8');
  assert.doesNotMatch(saved,/PRIVATE_API_KEY/);
  let respond,metadataReads=0;
  const restarted=createCodexCatalog({root,metadataImpl:async()=>{metadataReads++;return clientMetadata();},fetchImpl:()=>new Promise(resolve=>{respond=resolve;})});
  const models=await restarted.union(state,'0.165.0',new AbortController().signal);
  assert.equal(models.models[0].slug,'gpt-6.1-sol');assert.equal(metadataReads,1);
  assert.equal(restarted.supports('api',providers.api,'not-in-stale-cache'),true,'stale menus cannot claim current model exclusion');
  const next=await restarted.union(state,'0.165.0',new AbortController().signal);
  assert.equal(next.models[0].slug,'gpt-6.1-sol');
  respond(Response.json({data:[{id:'vendor-new'}]}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual((await restarted.union(state,'0.165.0',new AbortController().signal)).models.map(model=>model.slug),['vendor-new']);
});

test('legacy saved metadata is normalized before reuse instead of keeping the picker broken', async t => {
  const root = catalogRoot(t), providers = { api: { type: 'api', baseUrl: 'https://models.example/v1', apiKey: 'fixture' } };
  await createCodexCatalog({ root, metadataImpl: clientMetadata, fetchImpl: async () => Response.json({ data: [{ id: 'gpt-6.1-sol' }] }) })
    .union({ providers, order: ['api'] }, '0.171.0', new AbortController().signal);
  const file = path.join(root, 'model-catalog-cache.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(saved.api.models[0], { metadataReady: true, metadata: { supported_reasoning_levels: null, shell_type: null, visibility: null } });
  fs.writeFileSync(file, JSON.stringify(saved));
  const restarted = createCodexCatalog({ root, metadataImpl: clientMetadata, fetchImpl: async () => new Response('', { status: 503 }) });
  const { models } = await restarted.union({ providers, order: ['api'] }, '0.171.0', new AbortController().signal);
  assert.deepEqual(models.map(model => model.slug), ['gpt-6.1-sol']);
  assert.deepEqual(models[0].supported_reasoning_levels.map(level => level.effort), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.equal(models[0].visibility, 'list'); assert.equal(models[0].shell_type, 'shell_command');
});

test('packaged official metadata enriches exact IDs without launching an extra Codex process or adding available models',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'switch-packaged-metadata-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const binary=path.join(root,process.platform==='win32'?'codex.exe':'codex');
 fs.writeFileSync(path.join(root,'version.txt'),'fixture');
 fs.writeFileSync(path.join(root,'model-metadata.json'),JSON.stringify({version:'fixture',models:[{id:'gpt-6.1-sol',label:'Official Sol',efforts:['low','high'],defaultEffort:'high'},{id:'never-offered',label:'No',efforts:[]}]}));
 const result=await discoverModels({type:'api',baseUrl:'https://api.example/v1',apiKey:'fixture'},root,{binary,fetchImpl:async()=>Response.json({data:[{id:'gpt-6.1-sol'}]})});
 assert.deepEqual(result.models.map(model=>model.id),['gpt-6.1-sol']);assert.equal(result.models[0].label,'Official Sol');assert.deepEqual(result.models[0].efforts,['low','high']);
});

test('lazy Codex executable discovery supplies new model effort and reloads metadata when the executable changes', async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'switch-current-metadata-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const binary=path.join(root,process.platform==='win32'?'codex.exe':'codex');
 fs.writeFileSync(binary,'fixture');fs.writeFileSync(path.join(root,'version.txt'),'first');
 const save=(version,efforts)=>fs.writeFileSync(path.join(root,'model-metadata.json'),JSON.stringify({version,models:[{id:'gpt-6.2-sol',label:'Current Sol',efforts,defaultEffort:efforts[0]}]}));
 save('first',['low','high','xhigh','max','ultra']);
 const result=await discoverModels({type:'api',baseUrl:'https://api.example/v1',apiKey:'fixture'},root,{binary:()=>binary,fetchImpl:async()=>Response.json({data:[{id:'gpt-6.2-sol'},{id:'vendor-model'}]})});
 assert.deepEqual(result.models.map(model=>model.id),['gpt-6.2-sol','vendor-model']);
 assert.deepEqual(result.models[0].efforts,['low','high','xhigh','max','ultra']);assert.deepEqual(result.models[1].efforts,[]);
 assert.deepEqual((await codexModelMetadata(()=>binary))[0].supported_reasoning_levels.map(level=>level.effort),result.models[0].efforts);
 fs.writeFileSync(binary,'updated fixture');fs.writeFileSync(path.join(root,'version.txt'),'second');save('second',['medium','high']);
 const updated=await codexModelMetadata(()=>binary);
 assert.deepEqual(updated[0].supported_reasoning_levels.map(level=>level.effort),['medium','high']);
});

test('API availability is shared but reasoning metadata stays isolated across desktop and editor versions and restarts', async t => {
  const root = catalogRoot(t), provider = { type: 'api', baseUrl: 'https://models.example/v1', apiKey: 'PRIVATE' };
  const state = { providers: { api: provider }, order: ['api'] }, signal = new AbortController().signal;
  const old = '0.170.0', current = '0.172.0', model = 'gpt-6.2-sol'; let requests = 0;
  const metadataImpl = async version => [nativeModel(model, 0, version === old ? ['low'] : ['low', 'high', 'ultra'])];
  const catalog = createCodexCatalog({ root, metadataImpl, fetchImpl: async () => { requests++; return Response.json({ data: [{ id: model }, { id: 'vendor', supported_reasoning_levels: [] }] }); } });
  for (const version of [old, current, old, current]) {
    const { models } = await catalog.union(state, version, signal);
    assert.deepEqual(models[0].supported_reasoning_levels.map(level => level.effort), version === old ? ['low'] : ['low', 'high', 'ultra']);
    assert.deepEqual(models[1].supported_reasoning_levels, [], 'preserve explicit upstream capabilities');
  }
  assert.equal(requests, 1, 'switching clients does not refetch version-independent API availability');
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'model-catalog-cache.json'), 'utf8'));
  assert.equal(saved.api.models[0].metadata.supported_reasoning_levels, undefined, 'persist upstream metadata without client enrichment');
  const restarted = createCodexCatalog({ root, metadataImpl, fetchImpl: async () => new Response('', { status: 503 }) });
  assert.deepEqual((await restarted.union(state, current, signal)).models[0].supported_reasoning_levels.map(level => level.effort), ['low', 'high', 'ultra']);
});

test('exact official model IDs retain context and compaction metadata even without a local Codex helper', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-context-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const providers = { api: { type: 'api', baseUrl: 'https://api.example/v1', apiKey: 'fixture' } };
  const catalog = createCodexCatalog({ root, metadataImpl: async () => [], fetchImpl: async () => Response.json({ data: [
    { id: 'gpt-6.1-sol' }, { id: 'vendor-model', context_window: 64000, auto_compact_token_limit: 50000 },
  ] }) });
  const { models } = await catalog.union({ providers, order: ['api'] }, '0.163.0', new AbortController().signal);
  assert.deepEqual(models.map(model => model.slug), ['gpt-6.1-sol', 'vendor-model']);
  assert.equal(models[0].context_window, 272000);
  assert.equal(models[0].auto_compact_token_limit, null, 'Codex derives its native threshold from the context window when no explicit limit is provided');
  assert.equal(models[1].context_window, 64000);
  assert.equal(models[1].auto_compact_token_limit, 50000);
});
