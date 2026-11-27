import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { codexResetCredits, normalizeResetCredits } from '../desktop/reset-credits.js';
import { DesktopController } from '../desktop/controller.js';
import { atomic, accountAuth, addProvider, readState } from '../src/store.js';

const card = (id, expiresAt) => ({ id, expiresAt, grantedAt: 100, status: 'available', resetType: 'codexRateLimits', title: 'Reset card' });
const limits = { rateLimitResetCredits: { availableCount: 3, credits: [card('later', 2000000000), card('soon', 1900000000), card('forever', null)] } };
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-reset-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const provider = { type: 'account', accountHome: path.join(directory, 'account') }, requests = [];
  const original = { tokens: { access_token: 'fixture-secret', account_id: 'fixture-account' } };
  atomic(path.join(provider.accountHome, 'auth.json'), original);
  let temporary;
  const spawnImpl = (_binary, _args, config) => {
    temporary = config.env.CODEX_HOME;
    assert.notEqual(temporary, provider.accountHome);
    assert.equal(JSON.parse(fs.readFileSync(path.join(temporary, 'auth.json'))).auth_mode, 'chatgpt');
    assert.equal(config.env.OPENAI_API_KEY, undefined);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      const request = JSON.parse(chunk); requests.push(request);
      if (request.id && !options.timeout) queueMicrotask(() => {
        const result = request.method === 'initialize' ? {} : request.method.endsWith('/consume') ? { outcome: options.outcome || 'reset', secret: 'never-export' } : limits;
        child.stdout.write(JSON.stringify({ id: request.id, ...(options.error ? { error: { message: 'SECRET raw backend failure' } } : { result }) }) + '\n');
      });
      done();
    } });
    child.kill = () => { child.stdout.end(); child.emit('close', 0); };
    options.onSpawn?.(temporary, provider);
    return child;
  };
  return { provider, requests, spawnImpl, original, directory, temporary: () => temporary };
}
test('reset cards retain authoritative counts and individual expiry, including missing details and no expiry', () => {
  const result = normalizeResetCredits(limits);
  assert.equal(result.availableCount, 3); assert.deepEqual(result.credits.map(card => card.id), ['soon', 'later', 'forever']);
  assert.equal(result.credits[0].expiresAt, 1900000000000); assert.equal(result.credits[2].expiresAt, null); assert.equal(result.credits[2].expiryKnown, true);
  assert.deepEqual(normalizeResetCredits({}), { availableCount: null, credits: null });
  assert.deepEqual(normalizeResetCredits({ rateLimitResetCredits: { availableCount: 8, credits: null } }), { availableCount: 8, credits: null });
  const missing = normalizeResetCredits({ rateLimitResetCredits: { availableCount: 8, credits: [card('unknown')] } });
  assert.equal(missing.availableCount, 8); assert.equal(missing.credits[0].expiryKnown, false);
});
test('card reads use the requested subscription in isolation without login, threads or redemption', async t => {
  const fake = fixture(t);
  const result = await codexResetCredits({ ...fake, binary: 'fixture' });
  assert.equal(result.availableCount, 3);
  assert.deepEqual(fake.requests.map(request => request.method), ['initialize', 'initialized', 'account/rateLimits/read']);
  assert.equal(fs.existsSync(fake.temporary()), false); assert.deepEqual(accountAuth(fake.provider), fake.original);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|fixture-account/);
});
test('redemption sends the selected opaque card ID and the exact idempotency key for every official outcome', async t => {
  for (const outcome of ['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit']) {
    const fake = fixture(t, { outcome }), idempotencyKey = randomUUID();
    assert.deepEqual(await codexResetCredits({ ...fake, binary: 'fixture', creditId: 'chosen-card', idempotencyKey }), { outcome });
    assert.deepEqual(fake.requests.at(-1), { id: 2, method: 'account/rateLimitResetCredit/consume', params: { creditId: 'chosen-card', idempotencyKey } });
    assert.equal(fs.existsSync(fake.temporary()), false);
  }
});
test('invalid redemption, timeouts and protocol errors cannot leak diagnostics or leave credentials behind', async t => {
  const fake = fixture(t);
  await assert.rejects(codexResetCredits({ ...fake, creditId: '', idempotencyKey: randomUUID() }), /Choose a reset card/);
  assert.equal(fake.requests.length, 0);
  for (const mode of ['error', 'timeout']) {
    const failing = fixture(t, { [mode]: true });
    await assert.rejects(codexResetCredits({ ...failing, timeoutMs: 10 }), error => /Unable to read reset cards/.test(error.message) && !error.message.includes('SECRET'));
    assert.equal(fs.existsSync(failing.temporary()), false);
  }
});
test('isolated account refresh is retained without replacing a concurrent sign-in', async t => {
  for (const concurrent of [false, true]) {
    const refreshed = { tokens: { access_token: 'refreshed', account_id: 'fixture-account' } };
    const newer = { tokens: { access_token: 'different-login', account_id: 'different-account' } };
    const fake = fixture(t, { onSpawn: (temporary, provider) => {
      atomic(path.join(temporary, 'auth.json'), refreshed);
      if (concurrent) atomic(path.join(provider.accountHome, 'auth.json'), newer);
    } });
    await codexResetCredits(fake);
    assert.deepEqual(accountAuth(fake.provider), concurrent ? newer : refreshed);
  }
});
test('controller resets the chosen account, refreshes cards, rejects concurrent redemption and preserves text routing', async t => {
  const fake = fixture(t), calls = [];
  let finish;
  const controller = new DesktopController({ root: path.join(fake.directory, 'switch'), codexHome: path.join(fake.directory, 'native'), binary: 'fixture',
    resetRequest: async options => {
      calls.push(options);
      if (options.creditId) return await new Promise(resolve => { finish = resolve; });
      return normalizeResetCredits(limits);
    } });
  controller.addAPI({ alias: 'api', key: 'fixture-api' }); addProvider('subscription', fake.provider, controller.root);
  assert.equal((await controller.resetCards('subscription')).availableCount, 3);
  await assert.rejects(controller.consumeReset({ alias: 'api', creditId: 'soon', idempotencyKey: randomUUID() }), /subscription/);
  await assert.rejects(controller.consumeReset({ alias: 'subscription' }), /reset card/);
  const idempotencyKey = randomUUID(), pending = controller.consumeReset({ alias: 'subscription', creditId: 'soon', idempotencyKey });
  await assert.rejects(controller.consumeReset({ alias: 'subscription', creditId: 'later', idempotencyKey: randomUUID() }), /already in progress/);
  finish({ outcome: 'reset' });
  const result = await pending; assert.equal(result.outcome, 'reset'); assert.equal(result.cards.availableCount, 3);
  assert.equal(calls.length, 3); assert.equal(calls[1].provider.accountHome, fake.provider.accountHome); assert.equal(calls[1].idempotencyKey, idempotencyKey);
  assert.equal(readState(controller.root).active, 'api'); assert.equal(fs.existsSync(controller.codexHome), false);
});
