import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverable, rejectionText } from '../src/failover.js';
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
