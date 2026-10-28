import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs';
import { codexModels, discoverModels } from '../src/catalog.js';

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
test('API models intersect the Codex catalog; unavailable discovery has an explicit notice', async () => {
  const catalogImpl = async () => [{ id: 'model-a', efforts: ['low'] }, { id: 'model-b', efforts: ['high'] }];
  const provider = { type: 'api', baseUrl: 'https://example.com/v1', apiKey: 'SECRET' };
  const result = await discoverModels(provider, '/unused', { catalogImpl, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://example.com/v1/models'); assert.equal(options.headers.authorization, 'Bearer SECRET'); assert.equal(options.redirect, 'error');
    return Response.json({ data: [{ id: 'model-b' }, { id: 'unrecognized' }] });
  } });
  assert.deepEqual(result.models.map(model => model.id), ['model-b']);
  const fallback = await discoverModels(provider, '/unused', { catalogImpl, fetchImpl: async () => new Response('SECRET', { status: 401 }) });
  assert.equal(fallback.models.length, 2); assert.match(fallback.notice, /无法读取/); assert.ok(!fallback.notice.includes('SECRET'));
  const account = await discoverModels({ type: 'account' }, '/unused', { catalogImpl, fetchImpl: async () => { throw Error('must not fetch'); } });
  assert.equal(account.models.length, 2);
});
