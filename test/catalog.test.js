import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomic, accountAuth } from '../src/store.js';
import { codexModels, discoverModels, createCodexCatalog } from '../src/catalog.js';

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
  assert.deepEqual(result.models[0].metadata, metadata);
  await assert.rejects(discoverModels(provider, '/unused', { fetchImpl: async () => new Response('', { status: 401 }) }), /live Codex model catalog/);
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
  const result = await discoverModels(provider, '/unused', { fetchImpl: async () => Response.json({ data: ids.map(id => ({ id })) }) });
  assert.deepEqual(result.models.map(model => model.id), ['gpt-6.1-sol', 'gpt-6-luna', 'vendor-2', 'vendor-10']);
  assert.equal(result.models[0].label, 'GPT-6.1-Sol');
  assert.deepEqual(result.models[0].efforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.equal(result.models[0].defaultEffort, 'low');
  assert.deepEqual(result.models[1].efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(result.models[2].efforts, []);
});

test('API-only union retains official effort choices and ignores provider order when sorting models', async () => {
  const providers = {
    first: { type: 'api', baseUrl: 'https://first.example/v1', apiKey: 'fixture' },
    second: { type: 'api', baseUrl: 'https://second.example/v1', apiKey: 'fixture' },
  };
  const catalog = createCodexCatalog({ root: '/unused', fetchImpl: async url => Response.json({ data: (url.includes('first')
    ? ['vendor-10', 'gpt-6-luna', 'codex-auto-review'] : ['vendor-2', 'gpt-6.1-sol']).map(id => ({ id })) }) });
  for (const order of [['first', 'second'], ['second', 'first']]) {
    const result = await catalog.union({ providers, order }, '0.165.0', new AbortController().signal);
    assert.deepEqual(result.models.map(model => model.slug), ['gpt-6.1-sol', 'gpt-6-luna', 'codex-auto-review', 'vendor-2', 'vendor-10']);
    assert.deepEqual(result.models[0].supported_reasoning_levels.map(level => level.effort), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    assert.equal(result.models[0].default_reasoning_level, 'low');
    assert.equal(result.models[2].visibility, 'hide');
    assert.deepEqual(result.models[3].supported_reasoning_levels, []);
    assert.ok(!result.models.some(model => model.slug === 'gpt-5.5'), 'bundled metadata must not add model availability');
  }
});

test('live subscription priorities and reasoning presets override reference defaults, including explicit empty choices', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-catalog-priority-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  atomic(path.join(root, 'auth.json'), { tokens: { access_token: 'fixture', account_id: 'fixture' } });
  const providers = {
    api: { type: 'api', baseUrl: 'https://example.com/v1', apiKey: 'fixture' },
    account: { type: 'account', accountHome: root },
  };
  const catalog = createCodexCatalog({ root, fetchImpl: async url => url.includes('chatgpt.com') ? Response.json({ models: [
    { slug: 'gpt-6.1-sol', display_name: 'Live Sol', priority: 20, supported_reasoning_levels: [], default_reasoning_level: null },
    { slug: 'gpt-6-luna', display_name: 'Live Luna', priority: 0, supported_reasoning_levels: [{ effort: 'high', description: 'Live high' }], default_reasoning_level: 'high', context_window: 100000 },
  ] }) : Response.json({ data: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-luna' }] }) });
  const result = await catalog.union({ providers, order: ['api', 'account'] }, '0.165.0', new AbortController().signal);
  assert.deepEqual(result.models.map(model => model.slug), ['gpt-6-luna', 'gpt-6.1-sol']);
  assert.equal(result.models[0].default_reasoning_level, 'high');
  assert.deepEqual(result.models[0].supported_reasoning_levels, [{ effort: 'high', description: 'Live high' }]);
  assert.equal(result.models[0].context_window, 100000);
  assert.deepEqual(result.models[1].supported_reasoning_levels, []);
  assert.equal(result.models[1].default_reasoning_level, null);
});

test('custom catalog labels retain official reasoning defaults when provider discovery fails', async () => {
  const providers = { api: { type: 'api', baseUrl: 'https://example.com/v1', apiKey: 'fixture', modelCatalog: [
    { id: 'vendor-model', label: 'My model' }, { id: 'gpt-6.1-sol', label: 'My Sol' },
  ] } };
  const catalog = createCodexCatalog({ root: '/unused', fetchImpl: async () => new Response('', { status: 403 }) });
  const result = await catalog.union({ providers, order: ['api'] }, '0.165.0', new AbortController().signal);
  assert.equal(result.models[0].slug, 'gpt-6.1-sol');
  assert.equal(result.models[0].display_name, 'My Sol');
  assert.equal(result.models[0].default_reasoning_level, 'low');
  assert.ok(result.models[0].supported_reasoning_levels.some(level => level.effort === 'high'));
  assert.equal(result.models[1].display_name, 'My model');
});
