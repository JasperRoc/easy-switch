import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverable, rejectionText, atCapacity, capacityDelay } from '../src/failover.js';
test('capacity classification is explicit and Retry-After respects backoff and HTTP dates', () => {
  for (const text of ['Selected model is at capacity. Please try a different model.', '{"error":{"code":"server_overloaded"}}', '{"response":{"error":{"code":"model_at_capacity"}}}']) assert.equal(atCapacity(text), true);
  for (const text of ['invalid image', 'context window exceeded', 'internal server error', '{"error":{"code":"invalid_request","message":"denied"},"input":"Selected model is at capacity"}']) assert.equal(atCapacity(text), false);
  assert.equal(capacityDelay(null, 0), 1000); assert.equal(capacityDelay('0', 1), 2000);
  assert.equal(capacityDelay('10', 0), 10000);
  assert.equal(capacityDelay('Thu, 01 Jan 1970 00:00:15 GMT', 1, 0), 15000);
});
test('server policy allows only explicit authorization/quota rejections', () => {
  for (const status of [401,402,429]) assert.equal(recoverable(status), true);
  for (const text of ['团队 今日额度不足', 'insufficient_quota', 'quota exhausted', '余额不足']) assert.equal(recoverable(403, text), true);
  for (const status of [400,403,408,500,503]) assert.equal(recoverable(status, 'access denied'), false);
});
test('error classification reads no more than 64 KiB and cancels remaining body', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(70000).fill(65)); }, cancel() { cancelled = true; } });
  assert.equal((await rejectionText(new Response(stream))).length, 65536);
  assert.equal(cancelled, true);
});

test('priority order skips failed, cooling, attempted, and unavailable providers', async () => {
  const { alternate } = await import('../src/failover.js');
  const api = { type: 'api', apiKey: 'key', baseUrl: 'https://example.com/v1' };
  const state = { providers: { a: api, b: api, c: api, invalid: { type: 'account', accountHome: '/missing-test-account' } }, order: ['invalid', 'c', 'b', 'a'] };
  assert.equal(alternate(state, 'a', new Map(), 0), 'c');
  assert.equal(alternate(state, 'a', new Map([['c', 100]]), 0), 'b');
  assert.equal(alternate(state, 'a', new Map(), 0, new Set(['c'])), 'b');
  delete state.order;
  assert.equal(alternate(state, 'a', new Map(), 0), 'b');
});
